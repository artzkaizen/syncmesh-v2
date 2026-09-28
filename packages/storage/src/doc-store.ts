import type {
  Cursors,
  DocAddress,
  DocEntryState,
  DocHead,
  DocHeadMode,
  DocLogEntry,
  DocStore,
} from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { StoreFailure, inTail, nextState } from "@syncmesh/engine";
import {
  hlcOf,
  jsonObject,
  parseActionId,
  parseAdapterId,
  parseLineageId,
  parsePeerId,
  parseSeqNum,
  type ColumnName,
  type JsonValue,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";

import type { SqlDriver, SqlRow, SqlValue } from "./driver.js";

import { dialectOf } from "./dialect.js";
import { attempt, inTransaction } from "./sql.js";

const STATES: ReadonlySet<string> = new Set<DocEntryState>([
  "tail",
  "covered",
  "bytes-missing",
  "orphaned",
  "failed",
  "adapter-missing",
]);
const MODES: ReadonlySet<string> = new Set<DocHeadMode>(["materialised", "checkpoint", "none"]);

const corrupt = (message: string) => new StoreFailure({ message: `doc log: ${message}` });

const hexOr = (id: string | undefined): SqlValue =>
  id === undefined ? null : hexToBytes(id).unwrap();

const params = (e: DocLogEntry): readonly SqlValue[] => [
  e.author,
  e.seq,
  e.index,
  e.table,
  e.key,
  e.column,
  hexOr(e.lineage),
  e.hlc[0].epochMilliseconds,
  e.hlc[1],
  hexOr(e.action),
  hexOr(e.undoOf),
  e.blob ?? null,
  e.size,
  e.state,
];

/** A nullable 16-byte column back to its id, through the id's own parser. */
const idOf = <T>(value: SqlValue | undefined, parse: (hex: string) => Result<T, unknown>) => {
  if (value === null || value === undefined) return Result.ok(undefined);
  if (!(value instanceof Uint8Array)) return Result.err(corrupt("an id column is not bytes"));
  return parse(bytesToHex(value)).mapError(() => corrupt("an id column is not 16 bytes"));
};

const count = (value: SqlValue | undefined): Result<number, StoreFailure> => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? Result.ok(n) : Result.err(corrupt("not a count"));
};

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below names a column this store wrote from the same brand; naming rules for these identifiers are owned by the schema */
const address = (
  tbl: SqlValue | undefined,
  key: SqlValue | undefined,
  col: SqlValue | undefined,
) => ({
  table: String(tbl) as TableName,
  key: String(key) as RowKey,
  column: String(col) as ColumnName,
});
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

function decodeEntry(row: SqlRow): Result<DocLogEntry, StoreFailure> {
  const [author, seq, idx, tbl, key, col, lineage, ms, logical, action, undoOf, blob, size, state] =
    row;
  return Result.gen(function* () {
    const peer = yield* parsePeerId(String(author)).mapError(() => corrupt("author"));
    const seqNum = yield* parseSeqNum(Number(seq)).mapError(() => corrupt("seq"));
    const index = yield* count(idx);
    const bytes = yield* count(size);
    const hlc = [yield* count(ms), yield* count(logical)] as const;
    if (!STATES.has(String(state))) return Result.err(corrupt(`unknown state ${String(state)}`));
    const lineageId = yield* idOf(lineage, parseLineageId);
    const actionId = yield* idOf(action, parseActionId);
    const undoId = yield* idOf(undoOf, parseActionId);
    const entry: DocLogEntry = {
      ...address(tbl, key, col),
      author: peer,
      seq: seqNum,
      index,
      hlc: hlcOf(...hlc),
      size: bytes,
      // SAFETY: checked against STATES, the whole of DocEntryState, just above
      state: String(state) as DocEntryState,
    };
    return Result.ok({
      ...entry,
      ...(lineageId !== undefined && { lineage: lineageId }),
      ...(actionId !== undefined && { action: actionId }),
      ...(undoId !== undefined && { undoOf: undoId }),
      ...(blob !== null && blob !== undefined && { blob: String(blob) }),
    });
  });
}

function decodeHead(row: SqlRow): Result<DocHead, StoreFailure> {
  const [tbl, key, col, adapter, lineage, covers, version, tailCount, tailBytes, mode, at] = row;
  return Result.gen(function* () {
    const adapterId = yield* parseAdapterId(String(adapter)).mapError(() => corrupt("adapter"));
    const lineageId = yield* idOf(lineage, parseLineageId);
    const floor = yield* coversOf(covers);
    if (!MODES.has(String(mode))) return Result.err(corrupt(`unknown mode ${String(mode)}`));
    const head: DocHead = {
      ...address(tbl, key, col),
      adapter: adapterId,
      covers: floor,
      tailCount: yield* count(tailCount),
      tailBytes: yield* count(tailBytes),
      // SAFETY: checked against MODES, the whole of DocHeadMode, just above
      mode: String(mode) as DocHeadMode,
    };
    return Result.ok({
      ...head,
      ...(lineageId !== undefined && { lineage: lineageId }),
      ...(version instanceof Uint8Array && { version }),
      ...(at !== null && at !== undefined && { materialisedAt: Number(at) }),
    });
  });
}

/** `covers` as the cursor map JSON a head keeps it in. */
const coversOf = (value: SqlValue | undefined): Result<Cursors, StoreFailure> =>
  Result.try({
    // SAFETY: JSON.parse returns JSON; `jsonObject` is the check that it is an object
    try: () => jsonObject(JSON.parse(String(value)) as JsonValue),
    catch: () => corrupt("covers is not JSON"),
  }).andThen((parsed) => {
    if (parsed === undefined) return Result.err(corrupt("covers is not an object"));
    const floor = new Map<PeerId, SeqNum>();
    for (const [peer, seq] of Object.entries(parsed)) {
      const p = parsePeerId(peer);
      const s = parseSeqNum(Number(seq));
      if (p.isErr() || s.isErr()) return Result.err(corrupt("covers"));
      floor.set(p.value, s.value);
    }
    return Result.ok<Cursors>(floor);
  });

export interface SqlDocStoreOptions {
  /** The caller holds the transaction; see `SqlEventStoreOptions.nested`. */
  readonly nested?: boolean;
}

/**
 * The doc log and heads (RFC-0023 §6.2) in the database behind `driver`, beside the event log and
 * the state: `doc_log`/`doc_heads` on a device, `_syncmesh_doc_log`/`_syncmesh_doc_heads` in an
 * app's Postgres. What an engine's `docStore` takes, and `openStores` opens.
 *
 * @example
 * const docs = (await sqlDocStore(driver)).unwrap();
 * const engine = createEngine({ ...options, docStore: docs });
 */
export function sqlDocStore(
  driver: SqlDriver,
  options: SqlDocStoreOptions = {},
): Promise<Result<DocStore, StoreFailure>> {
  const { docs: SQL, migrate } = dialectOf(driver);
  const transaction = <T>(fn: () => Promise<T>): Promise<T> =>
    options.nested === true ? fn() : inTransaction(driver, fn);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));
  const entriesOf = (doc: DocAddress) =>
    query("doc entries failed", SQL.selectDocEntries, [doc.table, doc.key, doc.column]).then(
      (rows) => rows.andThen((r) => Result.all(r.map(decodeEntry))),
    );

  const store: DocStore = {
    append: (entries) =>
      attempt("doc append failed", () =>
        transaction(async () => {
          for (const entry of entries) await driver.run(SQL.insertEntry, params(entry));
        }),
      ),
    entries: () =>
      query("doc entries failed", SQL.selectEntries).then((rows) =>
        rows.andThen((r) => Result.all(r.map(decodeEntry))),
      ),
    relineage: (doc, winner, live) =>
      Result.gen(async function* () {
        const held = yield* Result.await(entriesOf(doc));
        const moved = held.flatMap((e) => {
          const next = nextState(e, winner, live);
          return next === e.state ? [] : [[next, e.author, e.seq, e.index] as const];
        });
        yield* Result.await(
          attempt("doc relineage failed", () =>
            transaction(async () => {
              for (const bind of moved) await driver.run(SQL.updateState, bind);
            }),
          ),
        );
        return Result.ok(undefined);
      }),
    refreshHead: (doc, adapter, lineage) =>
      Result.gen(async function* () {
        const held = yield* Result.await(entriesOf(doc));
        const tail = held.filter((e) => e.lineage === lineage && inTail(e.state));
        const bytes = tail.reduce((n, e) => n + e.size, 0);
        const bind = [doc.table, doc.key, doc.column, adapter, hexOr(lineage), tail.length, bytes];
        yield* Result.await(attempt("doc head failed", () => driver.run(SQL.upsertHead, bind)));
        return Result.ok(undefined);
      }),
    heads: () =>
      query("doc heads failed", SQL.selectHeads).then((rows) =>
        rows.andThen((r) => Result.all(r.map(decodeHead))),
      ),
    uncoveredFloor: () =>
      query("doc floor failed", SQL.selectUncovered).then((rows) =>
        rows.andThen((r) =>
          Result.all(
            r.map(([author, min]) =>
              Result.gen(function* () {
                const peer = yield* parsePeerId(String(author)).mapError(() => corrupt("author"));
                const lowest = yield* count(min);
                // SAFETY: one below a positive sequence; 0 holds the author back entirely
                return Result.ok([peer, (lowest - 1) as SeqNum] as const);
              }),
            ),
          ).map((pairs) => new Map(pairs)),
        ),
      ),
  };

  if (options.nested === true) return Promise.resolve(Result.ok(store)); // the owner migrated
  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}
