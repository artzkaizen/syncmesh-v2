import type { EventStore } from "@syncmesh/engine";
import type { SyncEvent } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeEventCore, encodeEventCore } from "@syncmesh/wire";

import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

/** Applied in order on open; `PRAGMA user_version` records how many have run. */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS events (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      local INTEGER NOT NULL,
      hlc_ms INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      partition TEXT,
      core BLOB NOT NULL,
      PRIMARY KEY (peer, seq, local)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS events_hlc ON events (hlc_ms, hlc_logical)`,
  ],
];

const INSERT = `INSERT OR IGNORE INTO events
  (peer, seq, local, hlc_ms, hlc_logical, partition, core) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const SELECT_ALL = `SELECT core, local FROM events ORDER BY hlc_ms, hlc_logical, peer, seq`;
const SELECT_SINCE = `SELECT core, local FROM events
  WHERE local = 0
    AND seq > COALESCE((SELECT value FROM json_each(?) WHERE key = events.peer), 0)
  ORDER BY peer, seq`;
const SELECT_HAS = `SELECT 1 FROM events WHERE peer = ? AND seq = ? AND local = 0 LIMIT 1`;
const SELECT_LAST_SEQ = `SELECT MAX(seq) FROM events WHERE peer = ? AND local = ?`;
const SELECT_MAX_HLC = `SELECT core, local FROM events ORDER BY hlc_ms DESC, hlc_logical DESC LIMIT 1`;

const failure = (message: string) => (cause: unknown) => new StoreFailure({ message, cause });

const attempt = <T>(message: string, fn: () => Promise<T>) =>
  Result.tryPromise({ try: fn, catch: failure(message) });

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

const seqOf = (value: SqlValue | undefined) =>
  value === null || value === undefined
    ? Result.ok(undefined)
    : parseEventId(`${"0".repeat(64)}-${value}`)
        .map((parsed) => parsed.seqNum)
        .mapError(failure("stored sequence number is not a positive integer"));

async function migrate(driver: SqliteDriver): Promise<void> {
  const [row] = await driver.all("PRAGMA user_version");
  const applied = Number(row?.[0] ?? 0);
  for (const step of MIGRATIONS.slice(applied)) for (const sql of step) await driver.run(sql);
  await driver.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
}

/**
 * Opens the event log in the database behind `driver`, creating or migrating its tables.
 *
 * @example
 * const store = (await sqliteEventStore(bunSqliteDriver("app.db"))).unwrap();
 */
export function sqliteEventStore(driver: SqliteDriver): Promise<Result<EventStore, StoreFailure>> {
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));
  const inTransaction = <T>(fn: () => Promise<T>) =>
    driver.transaction === undefined ? fn() : driver.transaction(fn);

  const store: EventStore = {
    append: (event) => attempt("append failed", () => driver.run(INSERT, params(event))),
    appendBatch: (events) =>
      attempt("appendBatch failed", () =>
        inTransaction(async () => {
          for (const event of events) await driver.run(INSERT, params(event));
        }),
      ),
    has: (id) =>
      Result.gen(async function* () {
        const { peerId, seqNum } = yield* parseEventId(id).mapError(failure("malformed event id"));
        const rows = yield* Result.await(query("has failed", SELECT_HAS, [peerId, seqNum]));
        return Result.ok(rows.length > 0);
      }),
    all: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("all failed", SELECT_ALL));
        return decodeRows(rows);
      }),
    allSince: (cursors) =>
      Result.gen(async function* () {
        const floor = JSON.stringify(Object.fromEntries(cursors));
        const rows = yield* Result.await(query("allSince failed", SELECT_SINCE, [floor]));
        return decodeRows(rows);
      }),
    lastSeq: (peer, scope) =>
      Result.gen(async function* () {
        const local = scope === "local" ? 1 : 0;
        const rows = yield* Result.await(query("lastSeq failed", SELECT_LAST_SEQ, [peer, local]));
        return seqOf(rows[0]?.[0]);
      }),
    maxHlc: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("maxHlc failed", SELECT_MAX_HLC));
        const [row] = rows;
        if (row === undefined) return Result.ok(undefined);
        return decodeRow(row).map((event) => event.hlc);
      }),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}
