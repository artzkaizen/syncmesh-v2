import type { Cursors, DocEntryState, DocHead, DocHeadMode, DocLogEntry } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
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
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";

import type { SqlRow, SqlValue } from "./driver.js";

/** The doc log's and heads' rows, to and from the SQL a dialect binds and selects (RFC-0023 §6.2). */

const STATES: ReadonlySet<string> = new Set<DocEntryState>([
  "tail",
  "covered",
  "bytes-missing",
  "orphaned",
  "failed",
  "adapter-missing",
]);
const MODES: ReadonlySet<string> = new Set<DocHeadMode>(["materialised", "checkpoint", "none"]);

export const corrupt = (message: string) => new StoreFailure({ message: `doc log: ${message}` });

export const hexOr = (id: string | undefined): SqlValue =>
  id === undefined ? null : hexToBytes(id).unwrap();

export const params = (e: DocLogEntry): readonly SqlValue[] => [
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
export const idOf = <T>(
  value: SqlValue | undefined,
  parse: (hex: string) => Result<T, unknown>,
) => {
  if (value === null || value === undefined) return Result.ok(undefined);
  if (!(value instanceof Uint8Array)) return Result.err(corrupt("an id column is not bytes"));
  return parse(bytesToHex(value)).mapError(() => corrupt("an id column is not 16 bytes"));
};

/** `materialised_at`, kept as epoch milliseconds; absent while the column has no snapshot. */
const instantOf = (value: SqlValue | undefined) =>
  value === null || value === undefined
    ? Result.ok(undefined)
    : Result.try({
        try: () => Temporal.Instant.fromEpochMilliseconds(Number(value)),
        catch: () => corrupt("materialised_at is not an instant"),
      });

export const count = (value: SqlValue | undefined): Result<number, StoreFailure> => {
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

export function decodeEntry(row: SqlRow): Result<DocLogEntry, StoreFailure> {
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

export function decodeHead(row: SqlRow): Result<DocHead, StoreFailure> {
  const [tbl, key, col, adapter, lineage, covers, version, tailCount, tailBytes, mode, at] = row;
  return Result.gen(function* () {
    const adapterId = yield* parseAdapterId(String(adapter)).mapError(() => corrupt("adapter"));
    const lineageId = yield* idOf(lineage, parseLineageId);
    const floor = yield* coversOf(covers);
    const materialisedAt = yield* instantOf(at);
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
      ...(materialisedAt !== undefined && { materialisedAt }),
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
