import type { RowKey, Stamp, TableName } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
import { compareStamp, hlcOf, parsePeerId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { BlobHome } from "./blob-homes.js";
import type { BlobHash } from "./blob.js";
import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";

import { isBlobHash } from "./blob.js";
import { driverDialect, logTable, namespaceDdl, logPlacement } from "./dialect.js";
import { attempt, inTransaction } from "./sql.js";

/**
 * One row that has named a blob, as a relay that folds nothing can know it (gaps U18): every name
 * any write to it carried, and the stamps of its latest write and its latest delete. The row is
 * live while the write is the later of the two, as the kernel's own record is.
 */
export interface BlobRow {
  readonly table: TableName;
  readonly key: RowKey;
  readonly hashes: readonly BlobHash[];
  readonly written: Stamp | undefined;
  readonly deleted: Stamp | undefined;
}

/**
 * When a blob's sweep window started — its put, or the delete that released it — kept so that a
 * reopen does not start it over (gaps U18). `since` absent: the blob left the store, forget it.
 */
export interface BlobWindow {
  readonly hash: BlobHash;
  readonly since: Temporal.Instant | undefined;
}

/** The later of two stamps; either may be absent. */
export const laterStamp = (a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined =>
  a === undefined || (b !== undefined && compareStamp(b, a) > 0) ? b : a;

/**
 * Two records of one row joined: every name either carried, the later of each stamp. The join
 * is what makes a save safe to repeat and to reorder — a ledger only ever learns more.
 */
export const joinBlobRows = (kept: BlobRow | undefined, next: BlobRow): BlobRow =>
  kept === undefined
    ? next
    : {
        table: next.table,
        key: next.key,
        hashes: [...new Set([...kept.hashes, ...next.hashes])],
        written: laterStamp(kept.written, next.written),
        deleted: laterStamp(kept.deleted, next.deleted),
      };

/** What a relay knows about the references to its blobs, kept so that a trim of the log does not take it away. */
export interface BlobLedgerState {
  readonly rows: readonly BlobRow[];
  /** Each held blob's sweep window, so a room that reopens often still sweeps. */
  readonly windows: readonly BlobWindow[];
  /** Every partition a sealed event arrived in; `undefined` for one sealed with no partition. */
  readonly sealed: readonly BlobHome[];
  /**
   * Whether this ledger has seen every reference since the log began — it was started before the
   * log was ever trimmed. `undefined` from a ledger never saved. A ledger that is not complete
   * cannot vouch for a blob an earlier run left on disk.
   */
  readonly complete: boolean | undefined;
}

/**
 * The references a relay's blobs have, kept beside them (gaps U18). The log alone is not enough:
 * a row inserted once and never written again is live on every device after `keepEventsFor` trims
 * its insert, so what that insert named has to outlive it. Saved before every trim, so whatever a
 * trim removes was already written here.
 */
export interface BlobLedger {
  readonly load: () => Promise<Result<BlobLedgerState, StoreFailure>>;
  /**
   * Joins these rows into what was kept for them ({@link joinBlobRows}), sets or forgets these
   * windows, adds these sealed partitions and records `complete` — in one transaction where the
   * driver has them.
   */
  readonly save: (state: BlobLedgerState) => Promise<Result<void, StoreFailure>>;
  /**
   * Every blob the room's store holds and its size, an earlier run's included. Absent where the
   * ledger cannot see the store — a store in memory holds nothing an earlier run left.
   */
  readonly stored?: () => Promise<Result<ReadonlyMap<BlobHash, number>, StoreFailure>>;
}

/** A ledger for the life of this process: what a room with no durable store keeps. */
export function memoryBlobLedger(): BlobLedger {
  const rows = new Map<string, BlobRow>();
  const windows = new Map<BlobHash, Temporal.Instant>();
  const sealed = new Set<BlobHome>();
  let complete: boolean | undefined;
  return {
    load: () =>
      Promise.resolve(
        Result.ok({
          rows: [...rows.values()],
          windows: [...windows].map(([hash, since]) => ({ hash, since })),
          sealed: [...sealed],
          complete,
        }),
      ),
    save: (state) => {
      for (const row of state.rows) {
        const id = JSON.stringify([row.table, row.key]);
        rows.set(id, joinBlobRows(rows.get(id), row));
      }
      for (const { hash, since } of state.windows)
        if (since === undefined) windows.delete(hash);
        else windows.set(hash, since);
      for (const home of state.sealed) sealed.add(home);
      complete = state.complete;
      return Promise.resolve(Result.ok(undefined));
    },
  };
}

/** The column's spelling of "no partition", as in `blob_homes`. */
const UNPINNED = "";
const SEALED = "sealed ";
const COMPLETE = "complete";

/** A stamp as three columns; `null`s for none. */
const stampColumns = (stamp: Stamp | undefined): readonly SqlValue[] =>
  stamp === undefined
    ? [null, null, null]
    : [stamp.hlc[0].epochMilliseconds, stamp.hlc[1], stamp.peer];

/** Three columns back to a stamp; a stored stamp that does not read is a store fault. */
function parseStamp(
  ms: SqlValue | undefined,
  logical: SqlValue | undefined,
  peer: SqlValue | undefined,
): Result<Stamp | undefined, StoreFailure> {
  if (ms === null || ms === undefined) return Result.ok(undefined);
  const at = Number(ms);
  const count = Number(logical);
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(count) || at < 0 || count < 0)
    return Result.err(
      new StoreFailure({ message: "a blob row's stamp is not a pair of integers" }),
    );
  return parsePeerId(String(peer))
    .map((parsed): Stamp | undefined => ({ hlc: hlcOf(at, count), peer: parsed }))
    .mapError((cause) => new StoreFailure({ message: "a blob row's stamp names no peer", cause }));
}

/** One `blob_rows` row back to what was saved. */
function parseRow(row: SqlRow): Result<BlobRow, StoreFailure> {
  const [table, key, hashes, wMs, wLogical, wPeer, dMs, dLogical, dPeer] = row;
  const written = parseStamp(wMs, wLogical, wPeer);
  if (written.isErr()) return Result.err(written.error);
  const deleted = parseStamp(dMs, dLogical, dPeer);
  if (deleted.isErr()) return Result.err(deleted.error);
  return Result.ok({
    // SAFETY: written only by `save`, from a TableName
    table: String(table) as TableName,
    // SAFETY: written only by `save`, from a RowKey
    key: String(key) as RowKey,
    hashes: String(hashes).split(" ").filter(isBlobHash),
    written: written.value,
    deleted: deleted.value,
  });
}

/** One `blob_windows` row back to what was saved. */
function parseWindow([hash, ms]: SqlRow): Result<BlobWindow, StoreFailure> {
  const name = String(hash);
  const at = Number(ms);
  if (!isBlobHash(name) || !Number.isSafeInteger(at))
    return Result.err(new StoreFailure({ message: "a blob window is not a hash and an instant" }));
  return Result.ok({ hash: name, since: Temporal.Instant.fromEpochMilliseconds(at) });
}

/**
 * A ledger in the same database as the room's blobs and their homes, so a room reopened over a
 * trimmed log still knows what its kept blobs are for.
 *
 * @example
 * ```ts
 * const ledger = (await sqlBlobLedger(driver)).unwrap();
 * const state = (await ledger.load()).unwrap();
 * ```
 */
export async function sqlBlobLedger(driver: SqlDriver): Promise<Result<BlobLedger, StoreFailure>> {
  const { placeholder: p, name: dialect } = driverDialect(driver);
  const placement = logPlacement(driver);
  const ROWS = logTable("blob_rows", placement);
  const META = logTable("blob_ledger", placement);
  const BLOBS = logTable("blobs", placement);
  const WINDOWS = logTable("blob_windows", placement);
  const postgres = driver.dialect === "postgres";
  const integer = postgres ? "BIGINT" : "INTEGER";
  const values = (n: number): string => Array.from({ length: n }, (_, i) => p(i + 1)).join(", ");
  const columns =
    "tbl, row_key, hashes, written_ms, written_logical, written_peer, deleted_ms, deleted_logical, deleted_peer";
  const upsertRow = `INSERT INTO ${ROWS} (${columns}) VALUES (${values(9)}) ON CONFLICT (tbl, row_key) DO UPDATE SET hashes = excluded.hashes, written_ms = excluded.written_ms, written_logical = excluded.written_logical, written_peer = excluded.written_peer, deleted_ms = excluded.deleted_ms, deleted_logical = excluded.deleted_logical, deleted_peer = excluded.deleted_peer`;
  const selectRow = `SELECT ${columns} FROM ${ROWS} WHERE tbl = ${p(1)} AND row_key = ${p(2)}`;
  const upsertWindow = `INSERT INTO ${WINDOWS} (hash, since_ms) VALUES (${values(2)}) ON CONFLICT (hash) DO UPDATE SET since_ms = excluded.since_ms`;
  const deleteWindow = `DELETE FROM ${WINDOWS} WHERE hash = ${p(1)}`;
  const upsertMeta = `INSERT INTO ${META} (key, value) VALUES (${values(2)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

  const ledger: BlobLedger = {
    load: async () => {
      const rows = await attempt("blob ledger read failed", () =>
        driver.all(`SELECT ${columns} FROM ${ROWS}`),
      );
      if (rows.isErr()) return Result.err(rows.error);
      const meta = await attempt("blob ledger read failed", () =>
        driver.all(`SELECT key, value FROM ${META}`),
      );
      if (meta.isErr()) return Result.err(meta.error);
      const windows = await attempt("blob ledger read failed", () =>
        driver.all(`SELECT hash, since_ms FROM ${WINDOWS}`),
      );
      if (windows.isErr()) return Result.err(windows.error);
      const parsed = Result.all(rows.value.map(parseRow));
      if (parsed.isErr()) return Result.err(parsed.error);
      const sealed: BlobHome[] = [];
      let complete: boolean | undefined;
      for (const [key, value] of meta.value) {
        const name = String(key);
        if (name === COMPLETE) complete = String(value) === "true";
        else if (name.startsWith(SEALED)) {
          const home = name.slice(SEALED.length);
          // SAFETY: written only by `save`, from a PartitionKey or UNPINNED
          sealed.push(home === UNPINNED ? undefined : (home as BlobHome));
        }
      }
      const kept = Result.all(windows.value.map(parseWindow));
      if (kept.isErr()) return Result.err(kept.error);
      return Result.ok({ rows: parsed.value, windows: kept.value, sealed, complete });
    },
    save: async (state) => {
      const saved = await attempt("blob ledger write failed", () =>
        inTransaction(driver, async () => {
          // every row read and joined before anything is written: a kept row that does not read
          // leaves the ledger as it was, not half saved
          const joined: BlobRow[] = [];
          for (const row of state.rows) {
            const [found] = await driver.all(selectRow, [row.table, row.key]);
            const kept = found === undefined ? Result.ok(undefined) : parseRow(found);
            if (kept.isErr()) return Result.err(kept.error);
            joined.push(joinBlobRows(kept.value, row));
          }
          for (const row of joined)
            await driver.run(upsertRow, [
              row.table,
              row.key,
              row.hashes.join(" "),
              ...stampColumns(row.written),
              ...stampColumns(row.deleted),
            ]);
          for (const { hash, since } of state.windows)
            await (since === undefined
              ? driver.run(deleteWindow, [hash])
              : driver.run(upsertWindow, [hash, since.epochMilliseconds]));
          for (const home of state.sealed)
            await driver.run(upsertMeta, [`${SEALED}${home ?? UNPINNED}`, ""]);
          if (state.complete !== undefined)
            await driver.run(upsertMeta, [COMPLETE, String(state.complete)]);
          return Result.ok(undefined);
        }),
      );
      return saved.andThen((inner) => inner);
    },
    stored: async () =>
      (
        await attempt("blob inventory read failed", () =>
          driver.all(`SELECT hash, ${postgres ? "octet_length" : "length"}(bytes) FROM ${BLOBS}`),
        )
      ).map(
        (rows) =>
          new Map(
            rows.flatMap(([hash, size]) => {
              const name = String(hash);
              return isBlobHash(name) ? [[name, Number(size)] as const] : [];
            }),
          ),
      ),
  };
  const ddl = [
    ...namespaceDdl(dialect),
    `CREATE TABLE IF NOT EXISTS ${ROWS} (tbl TEXT NOT NULL, row_key TEXT NOT NULL, hashes TEXT NOT NULL, written_ms ${integer}, written_logical ${integer}, written_peer TEXT, deleted_ms ${integer}, deleted_logical ${integer}, deleted_peer TEXT, PRIMARY KEY (tbl, row_key))`,
    `CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${WINDOWS} (hash TEXT PRIMARY KEY, since_ms ${integer} NOT NULL)`,
  ];
  return attempt("blob ledger open failed", async () => {
    for (const sql of ddl) await driver.run(sql);
    return ledger;
  });
}
