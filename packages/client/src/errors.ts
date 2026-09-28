import { TaggedError } from "@syncmesh/result";

/** `createMesh` was given no `store` on a platform that has no durable default yet. */
export class NoDefaultStore extends TaggedError("NoDefaultStore")<{ message: string }> {}

/**
 * No transport here has the capability the call needs — carrying bytes out of band (D18), naming
 * a position in an ordered log (RFC-0020 §3.2). A fact about the medium, not a bug (D12): a raw
 * radio says so rather than pretending, and the caller gets a typed value rather than a crash.
 */
export class NoSuchCapability extends TaggedError("NoSuchCapability")<{
  capability: string;
  message: string;
}> {}

/**
 * This partition's content is sealed (book ch. 14) and this device holds no key for it, so there
 * is nothing here it could read or write.
 *
 * Refused at the handle rather than at the write, because both directions are affected: rows in
 * a sealed partition never folded here, so a read would answer "empty" for data that exists, and
 * a write would have to either leave in the clear — defeating the seal for everyone — or fail
 * somewhere a person cannot see. The key arrives inside a grant; until one does, this is the
 * honest answer.
 */
export class PartitionSealed extends TaggedError("PartitionSealed")<{
  partition: string;
  message: string;
}> {}

/**
 * No source this device can reach still holds what it asked for.
 *
 * A durable report and not a spinner (book ch. 18): the sources were tried, none of them could
 * vouch for the state, and the honest exit is `$recovery.export` — carry the bytes somewhere
 * that can read them. Nothing was changed here; the replica this device had is the replica it
 * still has.
 */
export class HistoryUnavailable extends TaggedError("HistoryUnavailable")<{
  /** The transports asked, by name, so an operator knows which rooms were even in scope. */
  sourcesTried: readonly string[];
  message: string;
}> {}

/**
 * A rebuild was asked for and refused before anything moved.
 *
 * The one case that matters: unsent work of this device's own. `rebuild` never deletes the
 * outbox, so the refusal is about the *operator's* expectation rather than about safety —
 * pass `preservePending: false` to say the writes may wait, and they will still be there.
 */
export class RebuildRefused extends TaggedError("RebuildRefused")<{
  reason: string;
  message: string;
}> {}
