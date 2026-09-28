import { TaggedError, isTaggedError, type AnyTaggedError } from "better-result";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- this file *is* the serialization boundary: JSON arrives untyped, the tag is the parse, and the field bag has no shape until the class that declared it revives */

/**
 * Tagged errors across a serialization boundary (book ch. 5): a failure leaves as
 * `{ _tag, message, ...fields }` and revives on the other side as the same class, so the tag
 * never leaves the type system and `matchError` keeps working after a network hop.
 */

/** A class the {@link createTaggedCatalog} can revive into: anything `TaggedError(tag)` made. */
export type RevivableTagged = new (props: never) => AnyTaggedError;

/**
 * A tagged error the wire carried but this side never declared. The original tag and fields
 * are data on it, so a caller can still branch — just not with the class it doesn't have.
 */
export class ForeignTagged extends TaggedError("ForeignTagged")<{
  readonly tag: string;
  readonly fields: Readonly<Record<string, unknown>>;
  message?: string;
}> {}

/**
 * The error as it crosses: the tag, the message, and every own field — never the stack, and
 * `cause` flattened to its message, because a stack is this process's business.
 */
export function serializeTagged(error: AnyTaggedError): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === "stack" || key === "name" || key === "_tag" || key === "cause") continue;
    fields[key] = value;
  }
  // `cause` rides the Error options, not an enumerable field — read it by name
  if (error.cause !== undefined)
    fields.cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  return { ...fields, _tag: error._tag, message: error.message };
}

export interface TaggedCatalog {
  /**
   * The wire shape back as an error: the declared class when the tag is in the catalog,
   * {@link ForeignTagged} when it is tagged but undeclared, `undefined` when it is not a
   * tagged wire at all.
   */
  readonly revive: (wire: unknown) => AnyTaggedError | undefined;
}

/** True for the `{ _tag: string, ... }` shape {@link serializeTagged} emits. */
const isTaggedWire = (wire: unknown): wire is { readonly _tag: string } =>
  typeof wire === "object" &&
  wire !== null &&
  "_tag" in wire &&
  typeof (wire as { _tag: unknown })._tag === "string";

/**
 * The classes one boundary declares, keyed by their tag. Registration instantiates each class
 * once with no fields to read the tag — the tag is an instance field by `better-result`'s
 * construction, and the constructor assigns only what it is given.
 *
 * @example
 * const catalog = createTaggedCatalog([StoreLocked, PolicyDenied]);
 * const revived = catalog.revive(JSON.parse(body).error); // instanceof StoreLocked again
 */
export function createTaggedCatalog(classes: readonly RevivableTagged[]): TaggedCatalog {
  // SAFETY: better-result constructors Object.assign the given props and nothing else, so an empty
  // props object yields an instance whose only field is the class's own tag
  const byTag = new Map(classes.map((cls) => [new cls({} as never)._tag, cls]));
  return {
    revive: (wire) => {
      if (isTaggedError(wire)) return wire;
      if (!isTaggedWire(wire)) return undefined;
      const { _tag, ...fields } = wire;
      const cls = byTag.get(_tag);
      // SAFETY: the wire fields are exactly what serializeTagged wrote from an instance of this class
      if (cls !== undefined) return new cls(fields as never);
      const message =
        "message" in fields && typeof fields.message === "string" ? fields.message : _tag;
      return new ForeignTagged({ tag: _tag, fields, message });
    },
  };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening */
