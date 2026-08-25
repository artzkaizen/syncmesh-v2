import type { EventStore } from "@syncmesh/engine";
import type { SyncEvent } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";

import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

import { migrate } from "./schema.js";
import { attempt, coverageOf, failure, hlcRow, inTransaction, seqOf } from "./sql.js";

const INSERT = `INSERT OR IGNORE INTO events
  (peer, seq, local, hlc_ms, hlc_logical, partition, core) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SELECT_ALL = `SELECT core, local FROM events ORDER BY hlc_ms, hlc_logical, peer, seq`;
const SELECT_SINCE = `SELECT core, local FROM events
  WHERE local = ?
    AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = events.peer), 0)
  ORDER BY peer, seq`;
const SELECT_HAS = `SELECT 1 FROM events WHERE peer = ? AND seq = ? AND local = ? LIMIT 1`;
const SELECT_LAST_SEQ = `SELECT MAX(seq) FROM (
  SELECT seq FROM events WHERE peer = ?1 AND local = ?2
  UNION ALL SELECT seq FROM compaction WHERE peer = ?1 AND local = ?2)`;
const COMPACTABLE = `FROM events
  WHERE local = ? AND hlc_ms < ?
    AND seq <= COALESCE((SELECT value FROM json_each(?) WHERE key = events.peer), 0)`;
const SELECT_COMPACTABLE = `SELECT peer, MAX(seq), COUNT(*) ${COMPACTABLE} GROUP BY peer`;
const SELECT_COMPACTABLE_STAMP = `SELECT hlc_ms, hlc_logical ${COMPACTABLE} AND peer = ?
  ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`;
const DELETE_COMPACTABLE = `DELETE ${COMPACTABLE}`;
const UPSERT_FLOOR = `INSERT INTO compaction (peer, local, seq, hlc_ms, hlc_logical)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (peer, local) DO UPDATE SET
    seq = MAX(seq, excluded.seq),
    hlc_logical = CASE
      WHEN excluded.hlc_ms > hlc_ms THEN excluded.hlc_logical
      WHEN excluded.hlc_ms = hlc_ms THEN MAX(hlc_logical, excluded.hlc_logical)
      ELSE hlc_logical END,
    hlc_ms = MAX(hlc_ms, excluded.hlc_ms)`;
const SELECT_FLOORS = `SELECT peer, local, seq FROM compaction`;
const SELECT_MAX_HLC = `SELECT hlc_ms, hlc_logical FROM (
  SELECT hlc_ms, hlc_logical FROM events UNION ALL SELECT hlc_ms, hlc_logical FROM compaction)
  ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`;

const params = (event: SyncEvent): readonly SqlValue[] => [
  event.peerId,
  event.seqNum,
  event.local === true ? 1 : 0,
  event.hlc[0].epochMilliseconds,
  event.hlc[1],
  event.partition ?? null,
  encodeEventCore(event),
];

function decodeRow(row: SqlRow): Result<SyncEvent, StoreFailure> {
  const [core, local] = row;
  if (!(core instanceof Uint8Array)) {
    return Result.err(new StoreFailure({ message: "event core is not a blob" }));
  }
  return decodeEventCore(core)
    .mapError(failure("stored event does not decode"))
    .map((event) => (local === 1 ? { ...event, local: true } : event));
}

const decodeRows = (rows: readonly SqlRow[]) => Result.all(rows.map(decodeRow));

/**
 * Opens the event log in the database behind `driver`, creating or migrating its tables.
 *
 * @example
 * const store = (await sqliteEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function sqliteEventStore(driver: SqliteDriver): Promise<Result<EventStore, StoreFailure>> {
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: EventStore = {
    append: (event) => attempt("append failed", () => driver.run(INSERT, params(event))),
    appendBatch: (events) =>
      attempt("appendBatch failed", () =>
        inTransaction(driver, async () => {
          for (const event of events) await driver.run(INSERT, params(event));
        }),
      ),
    has: (id) =>
      Result.gen(async function* () {
        const { peerId, seqNum, local } = yield* parseEventId(id).mapError(
          failure("malformed event id"),
        );
        const rows = yield* Result.await(
          query("has failed", SELECT_HAS, [peerId, seqNum, local ? 1 : 0]),
        );
        return Result.ok(rows.length > 0);
      }),
    all: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("all failed", SELECT_ALL));
        return decodeRows(rows);
      }),
    allSince: (cursors, scope = "synced") =>
      Result.gen(async function* () {
        const floor = JSON.stringify(Object.fromEntries(cursors));
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("allSince failed", SELECT_SINCE, [local, floor]));
        return decodeRows(rows);
      }),
    lastSeq: (peer, scope) =>
      Result.gen(async function* () {
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("lastSeq failed", SELECT_LAST_SEQ, [peer, local]));
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
          const groups = await driver.all(SELECT_COMPACTABLE, bind);
          let removed = 0;
          for (const [peer, max, count] of groups) {
            const [stamp] = await driver.all(SELECT_COMPACTABLE_STAMP, [...bind, peer ?? null]);
            const [ms, logical] = stamp ?? [null, null];
            await driver.run(UPSERT_FLOOR, [
              peer ?? null,
              local,
              max ?? null,
              ms ?? null,
              logical ?? null,
            ]);
            removed += Number(count);
          }
          if (removed > 0) await driver.run(DELETE_COMPACTABLE, bind);
          return removed;
        }),
      ),
    compactedBelow: () =>
      query("compactedBelow failed", SELECT_FLOORS).then((rows) =>
        rows
          .andThen(coverageOf)
          .mapError((e) =>
            e._tag === "StateCorrupt" ? new StoreFailure({ message: e.message }) : e,
          ),
      ),
    maxHlc: () =>
      query("maxHlc failed", SELECT_MAX_HLC).then((rows) => rows.andThen((r) => hlcRow(r[0]))),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}
