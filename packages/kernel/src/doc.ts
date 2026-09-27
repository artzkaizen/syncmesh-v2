import { Result, TaggedError } from "@syncmesh/result";

import type { RowKey, TableName } from "./change.js";
import type { Brand } from "./primitives.js";
import type { ColumnName } from "./record.js";

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
 * One update to one document column (change tag 6). Order-free at the fold: the update itself
 * belongs to the doc log and is never read as a cell value here. Syncmesh never interprets the bytes — the adapter the
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
