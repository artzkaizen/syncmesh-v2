import { Result, TaggedError } from "@syncmesh/result";

import type { DocColumns, LineageId } from "./doc.js";
import type { Ordering } from "./primitives.js";
import type { KeyedRecord } from "./state.js";

import { parseLineageId } from "./doc.js";
import { LOGICAL_MAX, hlcOf } from "./hlc.js";
import { parsePeerId } from "./peer-id.js";
import {
  isJsonArray,
  jsonObject,
  type CellValue,
  type JsonObject,
  type JsonValue,
} from "./record.js";
import { compareStamp, type Stamp } from "./stamp.js";

/**
 * The lineage cell as it is kept (RFC-0023 §5.3, §16.1; gaps U21): its geneses and anchor, the
 * versions it is tagged with, how a foreign one is read and refused, and its normal form.
 *
 * @module
 */

/**
 * One `replace()` as the lineage cell keeps it: the lineage it started, the lineage it replaced
 * (`undefined`, the root) and the genesis's stamp.
 */
export interface Genesis {
  readonly lineage: LineageId;
  readonly parent: LineageId | undefined;
  readonly stamp: Stamp;
}

/**
 * Where a document's lineage walk is settled (gaps U21): a lineage on the walk and its genesis's
 * stamp. A genesis carries one (data key 7) when the lineage it names was replaced long enough ago
 * that no sibling stamped before it can still arrive. Every genesis at or below that stamp, the
 * anchor's own among them, then leaves the lineage cell, and the walk starts at the anchor instead of the
 * root — which is what keeps the cell from growing with every `replace()`.
 */
export interface SettledLineage {
  readonly lineage: LineageId;
  readonly stamp: Stamp;
}

/** A genesis as one entry of the cell: `[parent | null, ms, logical, peer]`, keyed by its lineage. */
const genesisEntry = ({ parent, stamp }: Genesis): JsonValue => [
  parent ?? null,
  stamp.hlc[0].epochMilliseconds,
  stamp.hlc[1],
  stamp.peer,
];

/** A settled anchor as the cell's third element: `[lineage, ms, logical, peer]`. */
const anchorEntry = ({ lineage, stamp }: SettledLineage): JsonValue => [
  lineage,
  stamp.hlc[0].epochMilliseconds,
  stamp.hlc[1],
  stamp.peer,
];

const isCount = (n: JsonValue | undefined, max = Number.MAX_SAFE_INTEGER): n is number =>
  Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= max;

/**
 * The version of the lineage rule (RFC-0023 §16.1): `1` is the first-genesis tree. A genesis
 * carries it in key 5, and a lineage cell carries it as its tag wherever the cell is kept outside
 * events — snapshot pages, repair records, persisted state — so a build meets another rule's
 * geneses as a version it does not run, never as a root or a value to merge by LWW.
 */
export const GENESIS_RULE = 1;

/**
 * The first-genesis tree with a settled anchor (gaps U21): what a genesis that carries
 * {@link DocChange.settles} writes in key 5, and the tag of a cell holding an anchor,
 * `[2, { lineage → genesis }, [lineage, ms, logical, peer]]`. A build of {@link GENESIS_RULE}
 * alone refuses both, rather than fold the genesis without trimming what its peers trim.
 */
export const SETTLED_RULE = 2;

/** A stamp from an entry's `ms, logical, peer`, or `undefined` for anything else. */
function entryStamp(
  ms: JsonValue | undefined,
  logical: JsonValue | undefined,
  peer: JsonValue | undefined,
): Stamp | undefined {
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a foreign cell is read at its runtime shape, like `jsonObject` */
  const author = typeof peer === "string" ? parsePeerId(peer) : undefined;
  if (author?.isOk() !== true || !isCount(ms) || !isCount(logical, LOGICAL_MAX)) return undefined;
  return { hlc: hlcOf(ms, logical), peer: author.value };
}

/** One entry back, or `undefined` for anything that is not exactly the shape {@link genesisEntry} writes. */
function entryGenesis(lineage: string, entry: JsonValue | undefined): Genesis | undefined {
  const id = parseLineageId(lineage);
  if (id.isErr() || !isJsonArray(entry) || entry.length !== 4) return undefined;
  const [parent, ms, logical, peer] = entry;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- as above */
  const named = typeof parent === "string" ? parseLineageId(parent) : undefined;
  if (parent !== null && named?.isOk() !== true) return undefined;
  const stamp = entryStamp(ms, logical, peer);
  return stamp === undefined
    ? undefined
    : { lineage: id.value, parent: named?.unwrapOr(undefined), stamp };
}

/** The anchor back, or `undefined` for anything that is not the shape {@link anchorEntry} writes. */
function entryAnchor(entry: JsonValue | undefined): SettledLineage | undefined {
  if (!isJsonArray(entry) || entry.length !== 4) return undefined;
  const [lineage, ms, logical, peer] = entry;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- as above */
  const id = typeof lineage === "string" ? parseLineageId(lineage) : undefined;
  const stamp = entryStamp(ms, logical, peer);
  return id?.isOk() === true && stamp !== undefined ? { lineage: id.value, stamp } : undefined;
}

/**
 * The version a lineage cell is tagged with: the head of `[version, geneses, …]`, or `null` for a
 * cell with no tag — one written before cells were versioned (an object of geneses, or the
 * lineage id the last-writer-wins rule kept), or a value that is no cell at all.
 */
function cellVersion(value: CellValue | undefined): number | null {
  if (!isJsonArray(value)) return null;
  const [version] = value;
  return isCount(version) ? version : null;
}

/** A cell of a rule this build runs, its geneses still as stored. */
interface StoredCell {
  readonly geneses: JsonObject;
  readonly settled?: SettledLineage;
}

/**
 * A cell tagged {@link GENESIS_RULE} (`[1, geneses]`) or {@link SETTLED_RULE} (`[2, geneses,
 * anchor]`), or `undefined` for any other value: another version, no tag, or a shape neither
 * version writes.
 */
function storedCell(value: CellValue | undefined): StoredCell | undefined {
  if (!isJsonArray(value)) return undefined;
  const version = cellVersion(value);
  const geneses = jsonObject(value[1]);
  if (geneses === undefined) return undefined;
  if (version === GENESIS_RULE && value.length === 2) return { geneses };
  if (version !== SETTLED_RULE || value.length !== 3) return undefined;
  const settled = entryAnchor(value[2]);
  return settled === undefined ? undefined : { geneses, settled };
}

/** What a lineage cell holds: its geneses, and the anchor its walk starts from, if one settled it. */
export interface LineageCell {
  readonly geneses: readonly Genesis[];
  readonly settled?: SettledLineage;
}

/**
 * A lineage cell read: every genesis it holds, by lineage id, and its settled anchor. Within a
 * cell of a version this build runs, an entry that is not the shape the rule writes — one a peer
 * mangled — is skipped entry by entry, so every peer reads the same foreign value the same way. A
 * cell of another version holds nothing this rule can read: {@link parseLineageCells} refuses it
 * where it enters.
 */
export function readLineageCell(value: CellValue | undefined): LineageCell {
  const held = storedCell(value);
  if (held === undefined) return { geneses: [] };
  const geneses = Object.keys(held.geneses)
    .sort()
    .flatMap((lineage) => entryGenesis(lineage, held.geneses[lineage]) ?? []);
  return held.settled === undefined ? { geneses } : { geneses, settled: held.settled };
}

/** Every genesis a lineage cell holds, by lineage id (see {@link readLineageCell}). */
export const cellGeneses = (value: CellValue | undefined): readonly Genesis[] =>
  readLineageCell(value).geneses;

/**
 * A lineage cell that arrived outside an event — in a snapshot page, a repair record or persisted
 * state — tagged with a version of the lineage rule this build does not run (RFC-0023 §16.1).
 * `version` is `null` for a cell with no tag, written before cells were versioned.
 */
export class LineageCellRefused extends TaggedError("LineageCellRefused")<{
  table: string;
  key: string;
  column: string;
  version: number | null;
  message: string;
}> {}

/**
 * Checks every doc column's cell in `rows` against the lineage rules this build runs, and hands
 * the rows back when each one is a cell of {@link GENESIS_RULE} or {@link SETTLED_RULE}. The first
 * that is not is refused, so a caller joins none of the rows rather than read that cell as the
 * root or merge it by another rule. A column absent from a record is the root and passes.
 *
 * @example
 * parseLineageCells(snapshot.rows, docs).isErr(); // true when a page carries another rule's cell
 */
export function parseLineageCells(
  rows: Iterable<KeyedRecord>,
  docs: DocColumns,
): Result<readonly KeyedRecord[], LineageCellRefused> {
  const checked: KeyedRecord[] = [];
  for (const row of rows) {
    for (const column of docs.get(row.table)?.keys() ?? []) {
      const cell = row.record.cells.get(column);
      if (cell === undefined || storedCell(cell.value) !== undefined) continue;
      const version = cellVersion(cell.value);
      const found =
        version === null
          ? "a lineage cell with no version"
          : version === GENESIS_RULE || version === SETTLED_RULE
            ? `a lineage cell tagged ${version} in a shape that version never writes`
            : `a lineage cell of version ${version}`;
      return Result.err(
        new LineageCellRefused({
          table: row.table,
          key: row.key,
          column,
          version,
          message: `${row.table}/${row.key}.${column}: ${found}; this build runs versions ${GENESIS_RULE} and ${SETTLED_RULE}`,
        }),
      );
    }
    checked.push(row);
  }
  return Result.ok(checked);
}

/** Which of two geneses goes first: the smaller stamp, then the smaller lineage, then the root parent. */
export const firstGenesis = (a: Genesis, b: Genesis): Ordering => {
  const byStamp = compareStamp(a.stamp, b.stamp);
  if (byStamp !== 0) return byStamp;
  if (a.lineage !== b.lineage) return a.lineage < b.lineage ? -1 : 1;
  if (a.parent === b.parent) return 0;
  if (a.parent === undefined) return -1;
  return b.parent === undefined || a.parent < b.parent ? -1 : 1;
};

/** Of two anchors, the one settled later: the larger stamp, then the larger lineage. */
export const laterAnchor = (
  a: SettledLineage | undefined,
  b: SettledLineage | undefined,
): SettledLineage | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const byStamp = compareStamp(a.stamp, b.stamp);
  if (byStamp !== 0) return byStamp > 0 ? a : b;
  return a.lineage >= b.lineage ? a : b;
};

/**
 * Whether `settled` has passed `genesis`: it is stamped at or below the anchor's stamp — the
 * anchor's own genesis among them, stamped exactly there. A passed genesis is off the walk for
 * good, so the cell drops it. The test reads the stamp alone, never the lineage the anchor names,
 * so dropping only grows as the anchor gets later, and the join stays order-free even when an
 * anchor names a lineage at a stamp that is not its genesis's.
 */
export const passed = (genesis: Genesis, settled: SettledLineage | undefined) =>
  settled !== undefined && compareStamp(genesis.stamp, settled.stamp) <= 0;

/**
 * A cell's value from its geneses and anchor, in normal form: a genesis the anchor passed is
 * dropped, one lineage appearing twice keeps its first by {@link firstGenesis}, and the tag says
 * which rule it holds — `[1, geneses]` with no anchor, `[2, geneses, anchor]` with one.
 */
export function writeCell(
  geneses: Iterable<Genesis>,
  settled: SettledLineage | undefined,
): CellValue {
  const held = new Map<LineageId, Genesis>();
  for (const genesis of geneses) {
    if (passed(genesis, settled)) continue;
    const kept = held.get(genesis.lineage);
    if (kept === undefined || firstGenesis(genesis, kept) < 0) held.set(genesis.lineage, genesis);
  }
  const entries = Object.fromEntries(
    [...held.keys()].sort().map((lineage) => {
      // SAFETY: every key came from `held`, so the lookup is always there
      const genesis = held.get(lineage) as Genesis;
      return [lineage, genesisEntry(genesis)];
    }),
  );
  return settled === undefined
    ? [GENESIS_RULE, entries]
    : [SETTLED_RULE, entries, anchorEntry(settled)];
}
