import { Result, TaggedError } from "@syncmesh/result";

import type { RowKey, TableName } from "./change.js";
import type { Brand, Ordering } from "./primitives.js";
import type { KeyedRecord } from "./state.js";
import type { MergeSpec, Strategy } from "./strategy.js";

import { hlcOf } from "./hlc.js";
import { parsePeerId } from "./peer-id.js";
import {
  isJsonArray,
  jsonObject,
  type Cell,
  type CellValue,
  type ColumnName,
  type JsonValue,
  type RowRecord,
} from "./record.js";
import { compareStamp, type Stamp } from "./stamp.js";
import { strategies } from "./strategy.js";

/**
 * A 16-byte id as 32 lowercase hex characters: what an action, and a lineage, is named by on the
 * wire (`bstr(16)`, RFC-0023 §5.2, §5.3). Held as text on this side, like a {@link PeerId}, so two
 * of them compare with `===` and key a `Map`.
 */
const ID16_HEX = /^[0-9a-f]{32}$/;

/** The action an event belongs to (event key 10), or the one it compensates (key 11). */
export type ActionId = Brand<string, "ActionId">;

/**
 * Which history of a document a doc change belongs to. Absent is the **root** lineage — the empty
 * document every replica starts from with no event at all — and only a `replace()` mints another,
 * derived from the event that carries its genesis (RFC-0023 §5.3).
 */
export type LineageId = Brand<string, "LineageId">;

/**
 * The adapter a doc column is merged by, as `name@major` — `"loro@1"`. The major is the
 * compatibility contract (RFC-0023 §10): a new one is a new column, never an in-place upgrade.
 */
export type AdapterId = Brand<string, "AdapterId">;

export class InvalidDocId extends TaggedError("InvalidDocId")<{
  input: string;
  message: string;
}> {}

const ADAPTER_ID = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

const parseId16 = <T extends ActionId | LineageId>(input: string): Result<T, InvalidDocId> =>
  ID16_HEX.test(input)
    ? // SAFETY: matched ID16_HEX, which is the whole invariant of both 16-byte id brands
      Result.ok(input as T)
    : Result.err(new InvalidDocId({ input, message: "expected 32 lowercase hex characters" }));

/** Parses an {@link ActionId} from its hex form. */
export const parseActionId = (input: string): Result<ActionId, InvalidDocId> =>
  parseId16<ActionId>(input);

/** Parses a {@link LineageId} from its hex form. */
export const parseLineageId = (input: string): Result<LineageId, InvalidDocId> =>
  parseId16<LineageId>(input);

/**
 * Parses an {@link AdapterId}: a lowercase name, `@`, and a major from 1.
 *
 * @example
 * parseAdapterId("loro@1").isOk(); // true
 * parseAdapterId("loro").isOk();   // false — the major is not optional
 */
export function parseAdapterId(input: string): Result<AdapterId, InvalidDocId> {
  if (!ADAPTER_ID.test(input))
    return Result.err(new InvalidDocId({ input, message: "expected `name@major`" }));
  // SAFETY: matched ADAPTER_ID, which is exactly the AdapterId invariant
  return Result.ok(input as AdapterId);
}

/** An update carried by D18 instead of inline: the SHA-256 of its bytes (64 lowercase hex) and its length. */
export interface DocBlobRef {
  readonly hash: string;
  readonly size: number;
}

/** The update's bytes, inline or by reference — exactly one of the two (RFC-0023 §5.1 keys 3, 4). */
export type DocUpdate =
  | { readonly bytes: Uint8Array; readonly blob?: never }
  | { readonly blob: DocBlobRef; readonly bytes?: never };

/**
 * One update to one document column (change tag 6). Order-free at the fold: its only effect on
 * kernel state is the genesis it adds to the lineage cell (see {@link winningLineage}); the update itself is
 * appended to the doc log, never read here. Syncmesh never interprets the bytes — the adapter the
 * change names is the only code that does, and the fold never runs one.
 */
export interface DocChange {
  readonly kind: "doc";
  readonly table: TableName;
  readonly key: RowKey;
  readonly column: ColumnName;
  readonly adapter: AdapterId;
  /** Absent is the root lineage. A genesis always names the lineage it starts. */
  readonly lineage?: LineageId;
  readonly update: DocUpdate;
  /** Only on a `replace()`: the update is the new lineage's whole snapshot. */
  readonly genesis?: true;
  /**
   * Only on a genesis written under the lineage rule before RFC-0023 §16.1 — key 5 `true` rather
   * than the rule's version. Decoded so a log that holds one still reads; refused at admission,
   * and never folded.
   */
  readonly legacy?: true;
  /**
   * Only on a genesis: the lineage it replaces — the one that won on the authoring device when it
   * was written. Absent is the root. What {@link winningLineage} walks.
   */
  readonly parent?: LineageId;
}

/**
 * One `replace()` as the lineage cell keeps it: the lineage it started, the lineage it replaced
 * (`undefined`, the root) and the genesis's stamp.
 */
export interface Genesis {
  readonly lineage: LineageId;
  readonly parent: LineageId | undefined;
  readonly stamp: Stamp;
}

/** A genesis as one entry of the cell: `[parent | null, ms, logical, peer]`, keyed by its lineage. */
const genesisEntry = ({ parent, stamp }: Genesis): JsonValue => [
  parent ?? null,
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

/** The largest logical counter an HLC holds on the wire, a u32. */
const LOGICAL_MAX = 0xff_ff_ff_ff;

/** One entry back, or `undefined` for anything that is not exactly the shape {@link genesisEntry} writes. */
function entryGenesis(lineage: string, entry: JsonValue | undefined): Genesis | undefined {
  const id = parseLineageId(lineage);
  if (id.isErr() || !isJsonArray(entry) || entry.length !== 4) return undefined;
  const [parent, ms, logical, peer] = entry;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a foreign cell is read at its runtime shape, like `jsonObject` */
  const named = typeof parent === "string" ? parseLineageId(parent) : undefined;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- as above */
  const author = typeof peer === "string" ? parsePeerId(peer) : undefined;
  if ((parent !== null && named?.isOk() !== true) || author?.isOk() !== true) return undefined;
  if (!isCount(ms) || !isCount(logical, LOGICAL_MAX)) return undefined;
  return {
    lineage: id.value,
    parent: named?.unwrapOr(undefined),
    stamp: { hlc: hlcOf(ms, logical), peer: author.value },
  };
}

/**
 * The version a lineage cell is tagged with: the head of `[version, geneses]`, or `null` for a
 * cell with no tag — one written before cells were versioned (an object of geneses, or the
 * lineage id the last-writer-wins rule kept), or a value that is no cell at all.
 */
function cellVersion(value: CellValue | undefined): number | null {
  if (!isJsonArray(value)) return null;
  const [version] = value;
  return isCount(version) ? version : null;
}

/** The geneses half of a cell tagged {@link GENESIS_RULE}, or `undefined` for any other value. */
const ruleGeneses = (value: CellValue | undefined) =>
  isJsonArray(value) && value.length === 2 && cellVersion(value) === GENESIS_RULE
    ? jsonObject(value[1])
    : undefined;

/**
 * Every genesis a lineage cell holds, by lineage id. Within a cell of this rule's version, an
 * entry that is not the shape the rule writes — one a peer mangled — is skipped entry by entry,
 * so every peer reads the same foreign value the same way. A cell of another version holds
 * nothing this rule can read: {@link parseLineageCells} refuses it where it enters.
 */
export function cellGeneses(value: CellValue | undefined): readonly Genesis[] {
  const held = ruleGeneses(value);
  if (held === undefined) return [];
  return Object.keys(held)
    .sort()
    .flatMap((lineage) => entryGenesis(lineage, held[lineage]) ?? []);
}

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
 * Checks every doc column's cell in `rows` against the lineage rule this build runs, and hands the
 * rows back when each one is a cell of {@link GENESIS_RULE}. The first that is not is refused, so
 * a caller joins none of the rows rather than read that cell as the root or merge it by another
 * rule. A column absent from a record is the root and passes.
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
      if (cell === undefined || ruleGeneses(cell.value) !== undefined) continue;
      const version = cellVersion(cell.value);
      const found =
        version === null
          ? "a lineage cell with no version"
          : version === GENESIS_RULE
            ? `a lineage cell tagged ${version} in a shape that version never writes`
            : `a lineage cell of version ${version}`;
      return Result.err(
        new LineageCellRefused({
          table: row.table,
          key: row.key,
          column,
          version,
          message: `${row.table}/${row.key}.${column}: ${found}; this build runs version ${GENESIS_RULE}`,
        }),
      );
    }
    checked.push(row);
  }
  return Result.ok(checked);
}

/** Which of two geneses goes first: the smaller stamp, then the smaller lineage, then the root parent. */
const firstGenesis = (a: Genesis, b: Genesis): Ordering => {
  const byStamp = compareStamp(a.stamp, b.stamp);
  if (byStamp !== 0) return byStamp;
  if (a.lineage !== b.lineage) return a.lineage < b.lineage ? -1 : 1;
  if (a.parent === b.parent) return 0;
  if (a.parent === undefined) return -1;
  return b.parent === undefined || a.parent < b.parent ? -1 : 1;
};

/**
 * The lineage a set of geneses settles on — **the one place the lineage rule lives** (RFC-0023
 * §5.3, decided in §16.1 on 2026-11-08: first genesis wins).
 *
 * The geneses form a tree: each names the lineage it replaced, and the root lineage is the tree's
 * root. Among the geneses that replaced one lineage, the one with the **smallest** stamp wins, so
 * a late `replace()` of a version a colleague already replaced loses instead of discarding their
 * work. The walk starts at the root, steps to the current winner's winning child, and stops at a
 * winner nothing replaced. A replace made on top of the winner — a restore, a reset to a template,
 * the undo of a replace — is that winner's child, so it still wins.
 *
 * A function of the set alone: the same geneses give the same lineage in any arrival order or
 * batching. A genesis whose parent is not held yet hangs off nothing the walk reaches until the
 * parent arrives, which is how out-of-order delivery resolves without parking anything.
 */
export function winningLineage(geneses: readonly Genesis[]): LineageId | undefined {
  const children = new Map<LineageId | undefined, Genesis>();
  for (const genesis of geneses) {
    const best = children.get(genesis.parent);
    if (best === undefined || firstGenesis(genesis, best) < 0)
      children.set(genesis.parent, genesis);
  }
  const walked = new Set<LineageId>();
  let at: LineageId | undefined;
  for (let next = children.get(at); next !== undefined; next = children.get(at)) {
    // one parent per genesis keeps the walk a path, but a peer can still name a cycle off the root
    if (walked.has(next.lineage)) break;
    walked.add(next.lineage);
    at = next.lineage;
  }
  return at;
}

/**
 * How two lineage cells join: the union of their geneses, by lineage id, tagged
 * `[GENESIS_RULE, { lineage → [parent | null, ms, logical, peer] }]`. A lattice join —
 * commutative, associative, idempotent — so peers folding the same geneses in any order hold the
 * same cell, and the winner is read from it by {@link winningLineage}, never stored. Two entries
 * for one lineage only come from an author who signed two events at one sequence; the first by
 * {@link firstGenesis} is kept, on every peer alike. The cell's stamp is the later of the two.
 */
export const lineageRule: Strategy = (incoming, current) => {
  const held = new Map(cellGeneses(current?.value).map((g) => [g.lineage, g]));
  for (const genesis of cellGeneses(incoming.value)) {
    const kept = held.get(genesis.lineage);
    if (kept === undefined || firstGenesis(genesis, kept) < 0) held.set(genesis.lineage, genesis);
  }
  const stamp =
    current === undefined || compareStamp(incoming.stamp, current.stamp) > 0
      ? incoming.stamp
      : current.stamp;
  const geneses = Object.fromEntries(
    [...held.keys()].sort().map((lineage) => {
      // SAFETY: every key came from `held`, so the lookup is always there
      const genesis = held.get(lineage) as Genesis;
      return [lineage, genesisEntry(genesis)];
    }),
  );
  return { value: [GENESIS_RULE, geneses], stamp };
};

/**
 * The rules a {@link MergeSpec} can name: the three row rules, and the lineage rule the kernel
 * puts on every doc column itself. Never a rule an app declares: a doc column is merged by an
 * adapter, and this is only the rule for which history it merges.
 */
export type CellRule = keyof typeof cellRules;

export const cellRules = { ...strategies, lineage: lineageRule } satisfies Readonly<
  Record<string, Strategy>
>;

/** Where a mesh declares its doc columns: per table, the column and the adapter it names. */
export type DocColumns = ReadonlyMap<TableName, ReadonlyMap<ColumnName, AdapterId>>;

/**
 * The merge spec with every doc column's cell under {@link lineageRule}. What every join of a
 * record — a fold, a repair, a snapshot page — must be given, so a doc column's cell is never
 * joined by a row rule that happens to be the default.
 */
export function withDocColumns(merge: MergeSpec | undefined, docs: DocColumns): MergeSpec {
  const joined = new Map<TableName, ReadonlyMap<ColumnName, CellRule>>(merge ?? []);
  for (const [table, columns] of docs) {
    const rules = new Map<ColumnName, CellRule>(joined.get(table) ?? []);
    for (const column of columns.keys()) rules.set(column, "lineage");
    joined.set(table, rules);
  }
  return joined;
}

/** The lineage cell a genesis writes: the one genesis, stamped with it. */
export const lineageCell = (genesis: Genesis): Cell => ({
  value: [GENESIS_RULE, { [genesis.lineage]: genesisEntry(genesis) }],
  stamp: genesis.stamp,
});

/**
 * The lineage a document is on: the winner of the geneses its cell holds (see
 * {@link winningLineage}), or `undefined` for the root lineage.
 */
export const docLineage = (
  record: RowRecord | undefined,
  column: ColumnName,
): LineageId | undefined => winningLineage(cellGeneses(record?.cells.get(column)?.value));
