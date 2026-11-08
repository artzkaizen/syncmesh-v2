import type { Coverage } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { MalformedFrame } from "@syncmesh/transport";
import type { CborValue } from "@syncmesh/wire";

import { interestFrom } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, omitUndefined } from "@syncmesh/result";
import { asPeer, decodeCursorPairs, decodeFrame, malformedFrame } from "@syncmesh/transport";
import { decodeCbor, encodeCbor, isSafeNonNegative, isString } from "@syncmesh/wire";

import { CHALLENGE_BYTES, KIND, NO_CURSORS, type RelayFrame } from "./frames.js";

const asWires = (value: CborValue | undefined): Result<readonly Uint8Array[], MalformedFrame> => {
  if (!Array.isArray(value)) return malformedFrame("wires are not an array");
  const wires: Uint8Array[] = [];
  for (const wire of value) {
    if (!(wire instanceof Uint8Array)) return malformedFrame("wire is not bytes");
    wires.push(wire);
  }
  return Result.ok(wires);
};

type ControlDecoder = (
  a: CborValue | undefined,
  b: CborValue | undefined,
  c: CborValue | undefined,
  d: CborValue | undefined,
  e: CborValue | undefined,
  f: CborValue | undefined,
) => Result<RelayFrame, MalformedFrame>;

const decodeJoin: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    if (!Array.isArray(a) || !a.every((v) => isSafeNonNegative(v)))
      return malformedFrame("join versions are not integers");
    const peerId = yield* asPeer(b);
    const cursors = yield* decodeCursorPairs(c);
    const interest = interestFrom(isString(d) ? d : undefined);
    if (e !== undefined && !(e instanceof Uint8Array))
      return malformedFrame("join proof is not bytes");
    // the body as the sender signed it: `b` is the peer's bytes and `d` its interest text, both
    // already validated above, so this is the sender's own core and not a reconstruction of it
    // SAFETY: `a`..`d` were just read out of a decoded CBOR array, so each is a CborValue
    const core = encodeCbor([a, b as CborValue, c as CborValue, (d ?? "") as CborValue]);
    const join = { kind: "join", versions: a, peerId, cursors, core } as const;
    return Result.ok(omitUndefined({ ...join, interest, proof: e }));
  });

const decodeChallenge: ControlDecoder = (a) =>
  a instanceof Uint8Array && a.length === CHALLENGE_BYTES
    ? Result.ok({ kind: "challenge", nonce: a } as const)
    : malformedFrame(`challenge is not ${CHALLENGE_BYTES} bytes`);

const decodeHello: ControlDecoder = (a, b, c, d, e, f) =>
  Result.gen(function* () {
    if (!isSafeNonNegative(a) || !isSafeNonNegative(b) || !isString(c))
      return malformedFrame("hello is not [version, keepalive, epoch, cursors]");
    const cursors = yield* decodeCursorPairs(d);
    // absent from a relay built before retention, and empty from one that trims nothing: both
    // mean the same thing, so an older relay is read rather than refused (D14's additive vector)
    const floor = e === undefined ? NO_CURSORS : yield* decodeCursorPairs(e);
    return Result.ok({
      kind: "hello",
      version: a,
      keepaliveMs: b,
      epoch: c,
      cursors,
      floor,
      // only a room that says so is durable: absent is a relay built before D42, and not a claim
      durable: f === 1,
    } as const);
  });

const decodeError: ControlDecoder = (a, b, c) => {
  if (!isString(a) || !isString(b)) return malformedFrame("error is not [code, message]");
  const error = { kind: "error", code: a, message: b } as const;
  // a `retention` refusal names the floor it was below (gaps U30), and only that code's third
  // element is read: another code's is a later additive element this build reads past, and a
  // floor that does not decode leaves the refusal standing without one (D14's additive vector)
  const floor = a === "retention" && c !== undefined ? decodeCursorPairs(c) : undefined;
  return Result.ok(floor?.isOk() === true ? { ...error, floor: floor.value } : error);
};

const decodeAck: ControlDecoder = (a, b) =>
  isString(a) && isSafeNonNegative(b)
    ? Result.ok({ kind: "ack", id: a, offset: b } as const)
    : malformedFrame("ack is not [id, offset]");

const decodePage: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    const grants = yield* asWires(a);
    const events = yield* asWires(b);
    if (!isSafeNonNegative(c) || !isSafeNonNegative(d))
      return malformedFrame("page tail is not [more, offset]");
    const page = { kind: "page", grants, events, more: c === 1, offset: d } as const;
    if (e === undefined) return Result.ok(page);
    if (!Array.isArray(e) || e.length !== 2 || !isString(e[1]))
      return malformedFrame("page scope is not [cursors, interest]");
    const synced = yield* decodeCursorPairs(e[0]);
    // `local` is never anyone else's to speak for: a relay describes the synced half and no more
    const scoped: Coverage = { synced, local: NO_CURSORS, scope: e[1] };
    return Result.ok({ ...page, scoped });
  });

/** An optional partition element: absent is the unnamed budget, anything else must parse. */
const optionalPartition = (
  value: CborValue | undefined,
  kind: string,
): Result<PartitionKey | undefined, MalformedFrame> => {
  if (value === undefined) return Result.ok(undefined);
  const parsed = isString(value) ? parsePartitionKey(value) : undefined;
  return parsed?.isOk() === true
    ? Result.ok(parsed.value)
    : malformedFrame(`${kind} partition is not a partition key`);
};

/** `[hash, bytes]` — the blob frame that carries content back. */
const decodeBlob: ControlDecoder = (a, b) =>
  isString(a) && b instanceof Uint8Array
    ? Result.ok({ kind: "blob", hash: a, bytes: b } as const)
    : malformedFrame("blob is not [hash, bytes]");

/** `[hash, bytes, partition?]` — content offered, and whose budget it is billed to. */
const decodeBlobPut: ControlDecoder = (a, b, c) =>
  Result.gen(function* () {
    if (!isString(a) || !(b instanceof Uint8Array))
      return malformedFrame("blob-put is not [hash, bytes]");
    const partition = yield* optionalPartition(c, "blob-put");
    return Result.ok(omitUndefined({ kind: "blob-put", hash: a, bytes: b, partition } as const));
  });

const decodeBlobRefused: ControlDecoder = (a, b, c, d, e) =>
  Result.gen(function* () {
    if (!isString(a) || !isString(b) || !isSafeNonNegative(c) || !isSafeNonNegative(d))
      return malformedFrame("blob-refused is not [hash, code, limit, used]");
    const partition = yield* optionalPartition(e, "blob-refused");
    return Result.ok(
      omitUndefined({
        kind: "blob-refused",
        hash: a,
        code: b,
        limit: c,
        used: d,
        partition,
      } as const),
    );
  });

/** `[hash]` — the frames that name one without carrying it. */
const decodeBlobHash =
  (kind: "blob-get" | "blob-missing" | "blob-stored"): ControlDecoder =>
  (a) =>
    isString(a) ? Result.ok({ kind, hash: a } as const) : malformedFrame(`${kind} is not [hash]`);

const decodeRelayed: ControlDecoder = (a, b) =>
  a instanceof Uint8Array && isSafeNonNegative(b)
    ? Result.ok({ kind: "relayed", wire: a, offset: b } as const)
    : malformedFrame("relayed is not [wire, offset]");

const decodeRefusal: ControlDecoder = (a) =>
  a instanceof Uint8Array
    ? Result.ok({ kind: "refusal", wire: a } as const)
    : malformedFrame("refusal is not [wire]");

/** One decoder per control tag; an unlisted tag is `unknown`, never an error (D14). */
const CONTROL = new Map<number, ControlDecoder>([
  [KIND.join, decodeJoin],
  [KIND.hello, decodeHello],
  [KIND.error, decodeError],
  [KIND.ka, () => Result.ok({ kind: "ka" } as const)],
  [KIND.ack, decodeAck],
  [KIND.page, decodePage],
  [KIND.relayed, decodeRelayed],
  [KIND.blobPut, decodeBlobPut],
  [KIND.blobGet, decodeBlobHash("blob-get")],
  [KIND.blob, decodeBlob],
  [KIND.blobMissing, decodeBlobHash("blob-missing")],
  [KIND.challenge, decodeChallenge],
  [KIND.blobStored, decodeBlobHash("blob-stored")],
  [KIND.blobRefused, decodeBlobRefused],
  [KIND.refusal, decodeRefusal],
]);

/**
 * Dispatched on the tag, and on the relay's own tags first. The two tag spaces cannot both claim
 * one — D14 put the control tags above the session tags precisely so they never collide — so the
 * order changes no outcome except this: `ka` is a bare tag with nothing after it, and the session
 * decoder refuses a one-element frame as malformed rather than passing it on as `unknown`. Asking
 * it first meant every keepalive decoded as an error; only the client's re-arm running before the
 * decode kept that from being visible.
 */
export function decodeRelayFrame(bytes: Uint8Array): Result<RelayFrame, MalformedFrame> {
  const outer = decodeCbor(bytes);
  const parts: readonly CborValue[] = outer.isOk() && Array.isArray(outer.value) ? outer.value : [];
  const [kind, a, b, c, d, e, f] = parts;
  const control = isSafeNonNegative(kind) ? CONTROL.get(kind) : undefined;
  if (control !== undefined) return control(a, b, c, d, e, f);
  // a bare tag is nobody's session frame — those all carry a payload — so an unrecognised one is
  // a tag some later version added and this build ignores (D14's additive vector), not junk
  if (parts.length === 1 && isSafeNonNegative(kind)) return Result.ok({ kind: "unknown" } as const);
  return Result.gen(function* () {
    const session = yield* decodeFrame(bytes);
    return Result.ok(
      session.kind === "unknown"
        ? ({ kind: "unknown" } as const)
        : ({ kind: "session", frame: session } as const),
    );
  });
}
