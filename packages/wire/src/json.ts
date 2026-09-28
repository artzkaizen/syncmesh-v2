import type { JsonObject, JsonValue } from "@syncmesh/kernel";

import { isJsonArray } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { decodeCbor } from "./cbor-decode.js";
import { compareKeys, encodeCbor } from "./cbor.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/**
 * The wire's values as JSON, losslessly: what a `curl`, a browser devtool or a log line reads
 * where a socket reads CBOR. Everything JSON can already say is said as itself; the three things
 * it cannot are boxed under a `$` key nothing else may start with — bytes as `{ "$hex": … }`,
 * a non-finite number as `{ "$num": "NaN" }`, and a map with a key that is not a plain string
 * as `{ "$map": [[key, value], …] }`. `fromJson` reads the same three boxes back, so the two are
 * inverse over every `CborValue`, and `encodeCbor(fromJson(toJson(v)))` is the bytes `v` had.
 */

const HEX = "$hex";
const NUM = "$num";
const MAP = "$map";

/* oxlint-disable anti-slop/no-runtime-typeof -- a serializer is the I/O boundary: it dispatches on the runtime type of the value it projects */

/** Whether a map projects to a plain object: every key a string, none spelling one of the boxes. */
const plainKeys = (entries: readonly (readonly [CborKey, CborValue])[]): boolean =>
  entries.every(([key]) => typeof key === "string" && !key.startsWith("$"));

/** The value as JSON, with bytes, non-finite numbers and non-string keys boxed under `$`. */
export function toJson(value: CborValue): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { [NUM]: String(value) };
  if (value instanceof Uint8Array) return { [HEX]: bytesToHex(value) };
  if (Array.isArray(value)) return value.map(toJson);
  // SAFETY: every other CborValue member was handled above; only the map remains
  const map = value as ReadonlyMap<CborKey, CborValue>;
  const entries = [...map.entries()].sort(([a], [b]) => compareKeys(a, b));
  if (plainKeys(entries))
    return Object.fromEntries(entries.map(([key, held]) => [key, toJson(held)]));
  return { [MAP]: entries.map(([key, held]) => [key, toJson(held)]) };
}

/** JSON that is not the projection of any `CborValue`: a box with the wrong shape inside it. */
export class MalformedJson extends TaggedError("MalformedJson")<{
  /** Where in the value, as `$map[3][1].$hex`-style path. */
  path: string;
  message: string;
}> {}

const NON_FINITE = new Map<string, number>([
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
]);

const isKey = (value: JsonValue): value is CborKey =>
  typeof value === "string" || typeof value === "number";

/** Every element in order, or the first element that would not read. */
const each = (
  items: readonly JsonValue[],
  path: string,
): Result<readonly CborValue[], MalformedJson> => {
  const out: CborValue[] = [];
  for (const [index, item] of items.entries()) {
    const read = fromJsonAt(item, `${path}[${String(index)}]`);
    if (read.isErr()) return read;
    out.push(read.value);
  }
  return Result.ok(out);
};

const hexBox = (inside: JsonValue | undefined, path: string): Result<CborValue, MalformedJson> =>
  typeof inside === "string"
    ? hexToBytes(inside).mapError(
        (failure) => new MalformedJson({ path, message: failure.message }),
      )
    : Result.err(new MalformedJson({ path, message: "$hex must be a string" }));

const numBox = (inside: JsonValue | undefined, path: string): Result<CborValue, MalformedJson> => {
  const number = typeof inside === "string" ? NON_FINITE.get(inside) : undefined;
  return number === undefined
    ? Result.err(
        new MalformedJson({
          path,
          message: "$num names NaN, Infinity or -Infinity and nothing else",
        }),
      )
    : Result.ok(number);
};

const mapBox = (inside: JsonValue | undefined, path: string): Result<CborValue, MalformedJson> => {
  if (!isJsonArray(inside))
    return Result.err(new MalformedJson({ path, message: "$map must be a list of pairs" }));
  const map = new Map<CborKey, CborValue>();
  for (const [index, pair] of inside.entries()) {
    const at = `${path}[${String(index)}]`;
    if (!isJsonArray(pair) || pair.length !== 2 || pair[0] === undefined || !isKey(pair[0]))
      return Result.err(
        new MalformedJson({ path: at, message: "a $map entry is a [key, value] pair" }),
      );
    const read = fromJsonAt(pair[1] ?? null, `${at}[1]`);
    if (read.isErr()) return read;
    map.set(pair[0], read.value);
  }
  return Result.ok(map);
};

const BOXES = new Map([
  [HEX, hexBox],
  [NUM, numBox],
  [MAP, mapBox],
]);

/** The value a `$` box stands for, or `undefined` for an object that is not one: a plain map. */
const boxed = (object: JsonObject, path: string): Result<CborValue, MalformedJson> | undefined => {
  const keys = Object.keys(object);
  const [key] = keys;
  if (keys.length !== 1 || key === undefined) return undefined;
  const read = BOXES.get(key);
  return read === undefined ? undefined : read(object[key], `${path}.${key}`);
};

const fromJsonAt = (json: JsonValue, path: string): Result<CborValue, MalformedJson> => {
  if (json === null || typeof json === "boolean" || typeof json === "string")
    return Result.ok(json);
  if (typeof json === "number") return Result.ok(json);
  if (isJsonArray(json)) return each(json, path);
  const box = boxed(json, path);
  if (box !== undefined) return box;
  const map = new Map<CborKey, CborValue>();
  for (const [key, held] of Object.entries(json)) {
    const read = fromJsonAt(held, `${path}.${key}`);
    if (read.isErr()) return read;
    map.set(key, read.value);
  }
  return Result.ok(map);
};

/** The `CborValue` a projection stands for; a `$` box with the wrong inside is {@link MalformedJson}. */
export const fromJson = (json: JsonValue): Result<CborValue, MalformedJson> =>
  fromJsonAt(json, "$");
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The two ways a wire value crosses HTTP: the socket's bytes, or their JSON projection. */
export type WireMedia = "application/cbor" | "application/json";

/** How strongly one `Accept` entry asks for a media type; `0` is a refusal. */
const acceptWeight = (entry: string) => {
  const [type = "", ...params] = entry.split(";").map((part) => part.trim());
  const q = params.find((param) => param.startsWith("q="))?.slice(2);
  const weight = q === undefined ? 1 : Number(q);
  return { type: type.toLowerCase(), q: Number.isFinite(weight) ? weight : 0 };
};

/**
 * Which of the two a caller asked for, read off its `Accept` header.
 *
 * JSON unless CBOR was asked for more strongly: a browser, a `curl` and a log reader all send
 * nothing or the wildcard, and what they can read is text. `application/cbor` at a higher weight
 * — a device, or a tool that decodes the socket's own bytes — gets the bytes.
 */
export function negotiate(accept: string | null | undefined): WireMedia {
  if (accept === undefined || accept === null) return "application/json";
  let json = 0;
  let cbor = 0;
  for (const entry of accept.split(",")) {
    const { type, q } = acceptWeight(entry);
    if (type === "application/json" || type === "application/*") json = Math.max(json, q);
    if (type === "application/cbor" || type === "application/*") cbor = Math.max(cbor, q);
    if (type === "*/*") {
      json = Math.max(json, q);
      cbor = Math.max(cbor, q);
    }
  }
  return cbor > json ? "application/cbor" : "application/json";
}

const utf8 = { encoder: new TextEncoder(), decoder: new TextDecoder("utf-8", { fatal: true }) };

/** The value as the bytes of one media type: canonical CBOR, or the JSON projection as UTF-8. */
export const serialize = (value: CborValue, media: WireMedia): Uint8Array =>
  media === "application/cbor"
    ? encodeCbor(value)
    : utf8.encoder.encode(JSON.stringify(toJson(value)));

/** JSON that would not parse at all, as against JSON that parsed to something no wire value projects to. */
export class UnreadableJson extends TaggedError("UnreadableJson")<{ message: string }> {}

/** Bytes of one media type back as the value; the CBOR path answers the decoder's own error. */
export const deserialize = (
  bytes: Uint8Array,
  media: WireMedia,
): Result<
  CborValue,
  ReturnType<typeof decodeCbor> extends Result<unknown, infer E>
    ? E | MalformedJson | UnreadableJson
    : never
> => {
  if (media === "application/cbor") return decodeCbor(bytes);
  return Result.try({
    // SAFETY: `JSON.parse` yields nothing but JSON values; `fromJson` below is the parse of their shape
    try: (): JsonValue => JSON.parse(utf8.decoder.decode(bytes)) as JsonValue,
    catch: (cause) =>
      new UnreadableJson({ message: cause instanceof Error ? cause.message : String(cause) }),
  }).andThen(fromJson);
};
