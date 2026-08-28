import type { EventStore, StoredEvent } from "@syncmesh/engine";

import { StoreFailure } from "@syncmesh/engine";
import { eventId, parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";

import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";

import { dialectOf } from "./dialect.js";
import { attempt, coverageOf, failure, hlcRow, inTransaction, seqOf } from "./sql.js";

/**
 * The `core` column holds the bytes the author's signature covers, not a re-encode of what this
 * build could read: `decodeEventCore` ignores map keys it has no name for, and re-encoding a
 * newer peer's event on the way back out would send bytes its signature does not cover.
 *
 * An event this device authored arrives here with no core — nothing has signed it yet — and is
 * encoded to fill the NOT NULL column. Those bytes are never forwarded: `envelopeOf` re-signs an
 * own event through `signEvent`, which encodes and signs in the same step.
 */
const params = ({ event, core, sig }: StoredEvent): readonly SqlValue[] => [
  event.peerId,
  event.seqNum,
  event.local === true ? 1 : 0,
  event.hlc[0].epochMilliseconds,
  event.hlc[1],
  event.partition ?? null,
  core ?? encodeEventCore(event),
  sig ?? null,
];

/**
 * One `(core, local, sig)` row back to the entry that was stored; the local flag rebuilds the id
 * the core does not carry. Shared with the `localStorage` log, so the two stores can never
 * disagree about what a stored event is.
 *
 * The core comes back as the entry's `core`, which is what a relay forwards. Rows written before
 * the log kept arrival bytes hold a re-encode under that column, so such a row relays exactly as
 * it did before this change — including refusal at the far side for an event that arrived with a
 * field this build's decoder dropped.
 *
 * Nothing repairs such a row in place, and it would be wrong to claim otherwise: the insert is
 * idempotent by `(peer, seq, local)` and a re-arrival is dropped by `admit`'s `store.has` before
 * the store ever sees it, so the column keeps what it has for the life of the database. The event
 * itself stays reachable — a peer can still get it from its author — but not through this row and
 * not through this device. Only compaction removes it.
 */
export function decodeStoredEvent(row: SqlRow): Result<StoredEvent, StoreFailure> {
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
      return { event, core, sig: sig instanceof Uint8Array ? sig : undefined };
    });
}

const decodeRows = (rows: readonly SqlRow[]) => Result.all(rows.map(decodeStoredEvent));

/**
 * Opens the event log in the database behind `driver`, creating or migrating its tables in the
 * driver's dialect — `events` on a device's SQLite, `_syncmesh_events` in an app's Postgres.
 *
 * @example
 * const store = (await sqlEventStore(bunSqlDriver("app.db"))).unwrap();
 */
export interface SqlEventStoreOptions {
  /**
   * The caller holds the transaction: the store runs its statements as they come and never opens
   * one of its own. What `openStores(...).atomic` builds, so the log and the state commit together.
   */
  readonly nested?: boolean;
}

export function sqlEventStore(
  driver: SqlDriver,
  options: SqlEventStoreOptions = {},
): Promise<Result<EventStore, StoreFailure>> {
  const { events: SQL, migrate } = dialectOf(driver);
  const transaction = <T>(fn: () => Promise<T>): Promise<T> =>
    options.nested === true ? fn() : inTransaction(driver, fn);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: EventStore = {
    append: (entry) => attempt("append failed", () => driver.run(SQL.insert, params(entry))),
    appendBatch: (entries) =>
      attempt("appendBatch failed", () =>
        transaction(async () => {
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
        transaction(async () => {
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

  if (options.nested === true) return Promise.resolve(Result.ok(store)); // the owner migrated
  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}

/** `sqlEventStore` under its SQLite-era name; the store speaks whatever dialect the driver has. */
export const sqliteEventStore = sqlEventStore;
