import type { StateStore } from "@syncmesh/engine";
import type { PeerId, RowKey, RowRecord, SeqNum, State, TableName } from "@syncmesh/kernel";

import { StateCorrupt, StoreFailure } from "@syncmesh/engine";
import { parsePeerId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

import { decodeRecord, encodeRecord } from "./record-codec.js";
import { migrate } from "./schema.js";
import { attempt, inTransaction, seqOf } from "./sql.js";

const UPSERT_ROW = `INSERT OR REPLACE INTO state_rows (tbl, key, record) VALUES (?, ?, ?)`;
const UPSERT_CURSOR = `INSERT OR REPLACE INTO state_cursors (peer, local, seq) VALUES (?, ?, ?)`;
const SELECT_ROWS = `SELECT tbl, key, record FROM state_rows`;
const SELECT_CURSORS = `SELECT peer, local, seq FROM state_cursors`;
const ANY_CURSOR = `SELECT 1 FROM state_cursors LIMIT 1`;

const corrupt = (message: string) => new StateCorrupt({ message });

function decodeRow(row: SqlRow): Result<readonly [TableName, RowKey, RowRecord], StateCorrupt> {
  const [table, key, record] = row;
  if (!(record instanceof Uint8Array)) return Result.err(corrupt("record is not a blob"));
  return decodeRecord(record)
    .mapError((e) => corrupt(e.message))
    .map((decoded) => {
      // SAFETY: these columns were written from a TableName and a RowKey by commit(); the record's decode is the check that the row is intact
      return [String(table) as TableName, String(key) as RowKey, decoded] as const;
    });
}

function decodeCursor(
  row: SqlRow,
): Result<readonly [PeerId, boolean, SeqNum], StateCorrupt | StoreFailure> {
  const [peer, local, seq] = row;
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(String(peer)).mapError((e) => corrupt(e.message));
    const seqNum = yield* seqOf(seq);
    if (seqNum === undefined) return Result.err(corrupt("cursor without a sequence number"));
    return Result.ok([peerId, local === 1, seqNum] as const);
  });
}

/**
 * Opens the persisted state in the database behind `driver`; shares the file with `sqliteEventStore`.
 *
 * @example
 * const driver = bunSqliteDriver("app.db");
 * const stateStore = (await sqliteStateStore(driver)).unwrap();
 */
export function sqliteStateStore(driver: SqliteDriver): Promise<Result<StateStore, StoreFailure>> {
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));

  const store: StateStore = {
    isEmpty: () =>
      query("isEmpty failed", ANY_CURSOR).then((r) => r.map((rows) => rows.length === 0)),
    loadAll: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadAll failed", SELECT_ROWS));
        const state = new Map<TableName, Map<RowKey, RowRecord>>();
        for (const row of rows) {
          const [table, key, record] = yield* decodeRow(row);
          const records = state.get(table) ?? new Map<RowKey, RowRecord>();
          records.set(key, record);
          state.set(table, records);
        }
        return Result.ok<State>(state);
      }),
    loadCursors: () =>
      Result.gen(async function* () {
        const rows = yield* Result.await(query("loadCursors failed", SELECT_CURSORS));
        const synced = new Map<PeerId, SeqNum>();
        const local = new Map<PeerId, SeqNum>();
        for (const row of rows) {
          const [peer, isLocal, seq] = yield* decodeCursor(row);
          (isLocal ? local : synced).set(peer, seq);
        }
        return Result.ok({ synced, local });
      }),
    commit: (rows, coverage) =>
      attempt("commit failed", () =>
        inTransaction(driver, async () => {
          for (const { table, key, record } of rows)
            await driver.run(UPSERT_ROW, [table, key, encodeRecord(record)]);
          for (const [peer, seq] of coverage.synced)
            await driver.run(UPSERT_CURSOR, [peer, 0, seq]);
          for (const [peer, seq] of coverage.local) await driver.run(UPSERT_CURSOR, [peer, 1, seq]);
        }),
      ),
    clear: () =>
      attempt("clear failed", () =>
        inTransaction(driver, async () => {
          await driver.run("DELETE FROM state_rows");
          await driver.run("DELETE FROM state_cursors");
        }),
      ),
  };

  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}
