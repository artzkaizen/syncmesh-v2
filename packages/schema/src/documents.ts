import { TaggedError } from "@syncmesh/result";

/**
 * A document adapter as a schema names it (RFC-0023 §4.1): a vetted, versioned package such as
 * `@syncmesh/loro`, never a function the app writes. The schema reads only `id`; the adapter's
 * operations live in the package and run after the fold, never in it.
 *
 * @template Doc The library's own document type that opening the column hands back.
 */
export interface DocumentAdapter<Doc = unknown> {
  /** `name@major`, the wire id every doc change carries — `"loro@1"`. */
  readonly id: `${string}@${number}`;
  /** Phantom: carries `Doc` for inference; never set. */
  readonly __doc?: Doc;
}

/** An adapter on a column whose storage is not bytes: the snapshot has nowhere to go. */
export class DocColumnNotBinary extends TaggedError("DocColumnNotBinary")<{
  column: string;
  message: string;
}> {}

/** An adapter on a key, `unique()` or `check()` column: none of those can hold a document. */
export class DocColumnConstraint extends TaggedError("DocColumnConstraint")<{
  column: string;
  message: string;
}> {}

/** A merge rule the column's kind cannot carry — D25's backstop for a cast past {@link MergeFor}. */
export class MergeKindMismatch extends TaggedError("MergeKindMismatch")<{
  column: string;
  message: string;
}> {}
