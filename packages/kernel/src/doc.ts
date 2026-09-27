import { Result, TaggedError } from "@syncmesh/result";

import type { RowKey, TableName } from "./change.js";
import type { Brand } from "./primitives.js";
import type { Cell, ColumnName, RowRecord } from "./record.js";
import type { MergeSpec, Strategy } from "./strategy.js";

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
 * kernel state is the lineage cell a genesis sets (see {@link lineageRule}); the update itself is
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
}

/**
 * How two geneses of one document resolve — **the one place the lineage rule lives** (RFC-0023
 * §5.3, open decision §16.1).
 *
 * Today the winner is the genesis with the greatest stamp: last-writer-wins, exactly like a
 * concurrent write to any cell, which is what buys row digests, snapshot pages, tombstones and
 * `insert`×`insert` for free. The alternative the owner is weighing is first-genesis-wins, which
 * would stop a late `replace()` discarding a colleague's work; it is the mirror image of this
 * join, and swapping it here swaps it for the fold, repairs and snapshot installs alike, because
 * every one of them reaches the lineage cell through {@link withDocColumns}.
 *
 * Whatever it becomes, it must stay a lattice join — commutative, associative, idempotent — or
 * peers folding the same geneses in different orders keep different documents.
 */
export const lineageRule: Strategy = strategies.lww;

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

/** The lineage cell a genesis writes: the lineage id as its value, stamped with the genesis. */
export const lineageCell = (lineage: LineageId, stamp: Cell["stamp"]): Cell => ({
  value: lineage,
  stamp,
});

/**
 * The lineage a document is on: the winning genesis's, or `undefined` for the root lineage. A
 * cell holding anything but a lineage id — a row write that reached a doc column before the
 * ladder refused those — reads as the root, so every peer reads the same foreign value the same way.
 */
export function lineageOf(
  record: RowRecord | undefined,
  column: ColumnName,
): LineageId | undefined {
  const value = record?.cells.get(column)?.value;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a foreign cell is read at its runtime shape, like `jsonObject` */
  if (typeof value !== "string") return undefined;
  return parseLineageId(value).unwrapOr(undefined);
}
