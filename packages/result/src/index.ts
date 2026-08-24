/**
 * `@syncmesh/result` — the one place syncmesh imports its Result from (D02, option A).
 *
 * It is `better-result`, re-exported. Every package imports from here, never from
 * `better-result` directly, so there is exactly one nominal `Result` for the
 * "no floating Result" lint to target and one place to swap if the library ever changes.
 *
 * Rules (README rule 4):
 * - a runtime failure is a value: return `Result.err(new SomeTaggedError({...}))`
 * - a definition mistake throws: `panic("table `x` declared twice")`
 */
export {
  Result,
  Ok,
  Err,
  TaggedError,
  Panic,
  UnhandledException,
  panic,
  isPanic,
  isTaggedError,
  matchError,
  matchErrorPartial,
} from "better-result";
export type {
  AnyTaggedError,
  InferErr,
  InferOk,
  TaggedErrorClass,
  TaggedErrorInstance,
} from "better-result";

import { panic } from "better-result";

/**
 * Exhaustiveness proof for a `switch` over `_tag` (or any union). Adding a member to
 * the union becomes a compile error until every switch handles it; reaching it at
 * runtime is a defect, so it panics.
 */
export function unreachable(value: never, what = "case"): never {
  return panic(`unhandled ${what}: ${JSON.stringify(value)}`);
}
