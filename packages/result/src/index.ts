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

export type { RevivableTagged, TaggedCatalog } from "./wire.js";
export { ForeignTagged, createTaggedCatalog, serializeTagged } from "./wire.js";

import { panic } from "better-result";

/**
 * Asserts a `switch` over a union is exhaustive; panics if reached at runtime.
 *
 * @param value The narrowed-to-`never` value from the `default` branch.
 * @param what Label for the panic message.
 * @throws {Panic} Always, when called.
 *
 * @example
 * switch (error._tag) {
 *   case "NoSuchTable": return error.table;
 *   default: return unreachable(error, "WriteError");
 * }
 */
export function unreachable(value: never, what = "case"): never {
  return panic(`unhandled ${what}: ${JSON.stringify(value)}`);
}

export type { Defined } from "./objects.js";
export { omitUndefined } from "./objects.js";
