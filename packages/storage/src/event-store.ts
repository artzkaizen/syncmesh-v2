import type { EventStore, StoredEvent } from "@syncmesh/engine";

import { StoreFailure } from "@syncmesh/engine";
import { eventId, parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";

import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";

import { dialectOf } from "./dialect.js";
import { attempt, coverageOf, failure, hlcRow, inTransaction, seqOf } from "./sql.js";

const params = ({ event, sig }: StoredEvent): readonly SqlValue[] => [
  event.peerId,
  event.seqNum,
  event.local === true ? 1 : 0,
  event.hlc[0].epochMilliseconds,
  event.hlc[1],
  event.partition ?? null,
  encodeEventCore(event),
  sig ?? null,
];

function decodeRow(row: SqlRow): Result<StoredEvent, StoreFailure> {
  const [core, local, sig] = row;
  if (!(core instanceof Uint8Array)) {
    return Result.err(new StoreFailure({ message: "event core is not a blob" }));
  }
  return decodeEventCore(core)
    .mapError(failure("stored event does not decode"))
    .map((decoded) => {
      const event =
        local === 1
          ? { ...decoded, id: eventId(decoded.peerId, decoded.seqNum, true), local: true as const }
          : decoded;
      return sig instanceof Uint8Array ? { event, sig } : { event };
    });
}

const decodeRows = (rows: readonly SqlRow[]) => Result.all(rows.map(decodeRow));

/**
 * Opens the event log in the database behind `driver`, creating or migrating its tables in the
 * driver's dialect — `events` on a device's SQLite, `_syncmesh_events` in an app's Postgres.
 *
 * @example
 * const store = (await sqlEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function sqlEventStore(driver: SqlDriver): Promise<Result<EventStore, StoreFailure>> {
  const { events: SQL, migrate } = dialectOf(driver);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: EventStore = {
    append: (entry) => attempt("append failed", () => driver.run(SQL.insert, params(entry))),
    appendBatch: (entries) =>
      attempt("appendBatch failed", () =>
        inTransaction(driver, async () => {
          for (const entry of entries) await driver.run(SQL.insert, params(entry));
        }),
      ),
    has: (id) =>
      Result.gen(async function* () {
        const { peerId, seqNum, local } = yield* parseEventId(id).mapError(
          failure("malformed event id"),
        );
        const rows = yield* Result.await(
          query("has failed", SQL.selectHas, [peerId, seqNum, local ? 1 : 0]),
        );
        return Result.ok(rows.length > 0);
      }),
    all: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("all failed", SQL.selectAll));
        return decodeRows(rows);
      }),
    allSince: (cursors, scope = "synced") =>
      Result.gen(async function* () {
        const floor = JSON.stringify(Object.fromEntries(cursors));
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("allSince failed", SQL.selectSince, [local, floor]));
        return decodeRows(rows);
      }),
    lastSeq: (peer, scope) =>
      Result.gen(async function* () {
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("lastSeq failed", SQL.selectLastSeq, [peer, local]));
        return seqOf(rows[0]?.[0]);
      }),
    compactBelow: (floor, scope, olderThan) =>
      attempt("compactBelow failed", () =>
        inTransaction(driver, async () => {
          const local = scope === "local" ? 1 : 0;
          const bind = [
            local,
            olderThan.epochMilliseconds,
            JSON.stringify(Object.fromEntries(floor)),
          ];
          const groups = await driver.all(SQL.selectCompactable, bind);
          let removed = 0;
          for (const [peer, max, count] of groups) {
            const [stamp] = await driver.all(SQL.selectCompactableStamp, [...bind, peer ?? null]);
            const [ms, logical] = stamp ?? [null, null];
            await driver.run(SQL.upsertFloor, [
              peer ?? null,
              local,
              max ?? null,
              ms ?? null,
              logical ?? null,
            ]);
            removed += Number(count);
          }
          if (removed > 0) await driver.run(SQL.deleteCompactable, bind);
          return removed;
        }),
      ),
    compactedBelow: () =>
      query("compactedBelow failed", SQL.selectFloors).then((rows) =>
        rows
          .andThen(coverageOf)
          .mapError((e) =>
            e._tag === "StateCorrupt" ? new StoreFailure({ message: e.message }) : e,
          ),
      ),
    maxHlc: () =>
      query("maxHlc failed", SQL.selectMaxHlc).then((rows) => rows.andThen((r) => hlcRow(r[0]))),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

/** `sqlEventStore` under its SQLite-era name; the store speaks whatever dialect the driver has. */
export const sqliteEventStore = sqlEventStore;
