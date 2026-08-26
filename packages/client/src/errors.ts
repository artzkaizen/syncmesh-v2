import { TaggedError } from "@syncmesh/result";

/** `createMesh` was given no `store` on a platform that has no durable default yet. */
export class NoDefaultStore extends TaggedError("NoDefaultStore")<{ message: string }> {}
