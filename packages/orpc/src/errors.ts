import { TaggedError } from "@syncmesh/result";

/**
 * The failures this layer mints itself (§2.7).
 *
 * The wire half was already right: `wireError` sends `{ _tag, message, ...fields }` and the
 * client revives the class the caller declared, with `ForeignTagged` for a tag outside its
 * catalog. What was still flattened was nearer than the wire — the places `api.ts` and `http.ts`
 * reached for a bare `new Error(message)` and handed a caller a string to read instead of a tag
 * to match on.
 *
 * A handler's own throw still rides as itself: a declared procedure error is already tagged, and
 * one this layer did not model has nothing truer to become.
 */

/**
 * The input did not satisfy the procedure's schema — the issues, joined, in `message`.
 *
 * A `TaggedError` rather than the `TypeError` this replaces, because a bad input is not a defect
 * in the program: it is the ordinary answer to a form, and a call site wants to branch on it
 * without reading prose.
 */
export class InputInvalid extends TaggedError("InputInvalid")<{
  message: string;
}> {}

/**
 * An input schema that validates asynchronously.
 *
 * Separate from {@link InputInvalid} because it is the other kind of wrong: the *schema* is
 * unusable, not the value. Nothing a caller does fixes it, so it reads as what it is — a
 * definition mistake found at the first call rather than a rejected input.
 */
export class SchemaNotSynchronous extends TaggedError("SchemaNotSynchronous")<{
  message: string;
}> {}

/**
 * The mutation ran, committed, and staged no change — so there is no event to report.
 *
 * This is `research/api-friction.md`'s sixth finding, which the tracker hit and worked around:
 * an `onConflictDoNothing` stages nothing on the second tap, and the call used to come back
 * `Err("mutation wrote nothing: no event to report")`. Honest, and it made **idempotence
 * unexpressible** — a caller could not tell *already done* from *failed*, because both were a
 * string in an untagged error.
 *
 * With a tag it is a branch: `NothingWritten` means the write was a no-op against state that
 * already said what it wanted, which for an idempotent mutation is success.
 */
export class NothingWritten extends TaggedError("NothingWritten")<{
  /** `"issues.create"` — which procedure staged nothing. */
  readonly path: string;
  message: string;
}> {}

/**
 * An `.authority()` call with no way to reach an authority.
 *
 * An authority call needs a route to the authority **now**, and a route counts hops — a phone
 * with no internet standing beside a peer that has it is routable. This is the other case: no
 * path exists at all, so the call fails immediately and typed, the way every RPC ever has.
 * Durable intent is a `.handler` mutation writing a request row; the mesh already has exactly
 * one park-and-deliver system and a queued RPC would be a second.
 */
export class AuthorityUnreachable extends TaggedError("AuthorityUnreachable")<{
  readonly path: string;
  message: string;
}> {}

/**
 * The server has no body bound for a gate the router declares.
 *
 * A deployment mistake, not a caller's: the shared chain declared `.authority()` and the process
 * answering for it was built without the `*.server.ts` half.
 */
export class NoBodyBound extends TaggedError("NoBodyBound")<{
  readonly path: string;
  message: string;
}> {}

/** A thrower's failure as the `Error` a `Result` carries; a bare value is wrapped, never lost. */
export const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
