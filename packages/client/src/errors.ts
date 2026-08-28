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
