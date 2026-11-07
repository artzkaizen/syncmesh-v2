import type { JsonValue } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

/**
 * What a window asks the server for (D43): a `query` procedure by its path, and the input the app
 * called it with. The procedure's handler is the whole query — its `where`, its `orderBy`, its
 * `limit` and its keyset `after` — so the wire carries no query language of its own.
 */
export interface ReadRequest {
  /** `"mail.inbox"`: the procedure, as `api.mail.inbox` names it. */
  readonly path: string;
  /** The call's input, unparsed; the procedure's own schema parses it on the server. */
  readonly input: JsonValue;
}

export class MalformedRequest extends TaggedError("MalformedRequest")<{ message: string }> {}

/** A request as wire text. */
export const requestText = (request: ReadRequest): string =>
  JSON.stringify([request.path, request.input]);

/* oxlint-disable anti-slop/no-runtime-typeof -- a JSON value dispatches on its runtime kind, and parsing wire text is the I/O boundary */

/** The same JSON with every object's keys in order, so two spellings of one input are one text. */
const canonical = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, canonical(inner)]),
  );
};

/**
 * Which read a row came from: the path and the input, whatever order its keys were written in.
 *
 * A row is one read's row. `search({ q: "cat" })` and `search({ q: "dog" })` may both return
 * mail `a` with a different snippet, so the two are two rows, and two windows asking the same
 * read are one.
 *
 * @example
 * readKey({ path: "mail.inbox", input: { limit: 50, folder: "inbox" } });
 * // '["mail.inbox",{"folder":"inbox","limit":50}]'
 */
export const readKey = (request: ReadRequest): string =>
  JSON.stringify([request.path, canonical(request.input)]);

/** Reads a request off the wire. The input stays unparsed: only the procedure knows its shape. */
export function parseRequest(text: string): Result<ReadRequest, MalformedRequest> {
  return Result.try({
    // SAFETY: JSON.parse returns JSON; its shape is checked below before it is used
    try: () => JSON.parse(text) as JsonValue,
    catch: () => new MalformedRequest({ message: "a read request is not JSON" }),
  }).andThen((json) => {
    if (!Array.isArray(json) || json.length !== 2 || typeof json[0] !== "string")
      return Result.err(new MalformedRequest({ message: "a read request is [path, input]" }));
    const [path, input] = json;
    return Result.ok({ path, input: input ?? null });
  });
}
/* oxlint-enable anti-slop/no-runtime-typeof */
