import type { Ahead, Cursors } from "@syncmesh/engine";
import type { PeerId, SchemaVersion } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { parseSchemaVersion } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { decodeCbor, encodeCbor, hexToBytes, isSafeNonNegative, isString } from "@syncmesh/wire";

import type { SnapshotFrame } from "./snap-frame.js";

import {
  KIND,
  MalformedFrame,
  aheadPairs,
  asPeer,
  cursorPairs,
  decodeAheadPairs,
  decodeCursorPairs,
  malformedFrame,
} from "./frame-parts.js";
import { decodeSnapshotFrame } from "./snap-frame.js";

export { MalformedFrame } from "./frame-parts.js";

export type Frame =
  | { readonly kind: "grant"; readonly wire: Uint8Array }
  | { readonly kind: "grant-request"; readonly peerId: PeerId; readonly invite?: string }
  | {
      readonly kind: "cursors";
      readonly from: PeerId;
      readonly cursors: Cursors;
      /** What they hold above those cursors; absent from an older build, which says nothing. */
      readonly ahead?: Ahead;
      /**
       * The app schema the sender's build declares (D31), at index 5: a reading for
       * `oldestSchema()`, never a gate. Absent from a build that declares none, and from an older
       * one.
       */
      readonly schemaVersion?: SchemaVersion;
    }
  | { readonly kind: "event"; readonly wire: Uint8Array }
  /** The ephemeral tier (D16): signed, never stored, dropped rather than queued. */
  | { readonly kind: "presence"; readonly wire: Uint8Array }
  /**
   * What the sender holds, as one fingerprint per table, together with the slice it counted.
   * A receiver that holds a different slice compares nothing rather than false-alarming.
   */
  | {
      readonly kind: "digest";
      readonly scope: string;
      /** What the sender had folded when it counted; a receiver holding otherwise concludes nothing. */
      readonly at: Cursors;
      readonly digests: ReadonlyMap<string, bigint>;
      /** What the sender held above `at` when it counted; without it nothing may be compared. */
      readonly ahead?: Ahead;
    }
  /** A signed acknowledgement of durable custody (book ch. 10): held, not accepted. */
  | { readonly kind: "receipt"; readonly wire: Uint8Array }
  /** A signed refusal of one event (D32): parked, never folded — information, never a veto. */
  | { readonly kind: "refusal"; readonly wire: Uint8Array }
  /** What the sender can reach and how far: one advertisement per destination (book ch. 17). */
  | { readonly kind: "routes"; readonly ads: readonly RouteAdWire[] }
  /**
   * The sequences the sender withheld from this peer because its grant does not cover them, and
   * the entitlement it judged by (D40). The receiver counts them as accounted for — never as
   * held — so the hole they leave stops stalling its holdback, while an event lost in transit
   * still stops its cursor: only a named sequence is skipped, never a range.
   */
  | { readonly kind: "withheld"; readonly scope: string; readonly withheld: Ahead }
  /** The join exchange (RFC-0019), one tag with a sub-kind of its own. */
  | SnapshotFrame
  /** A tag this build does not know; ignored, never an error. */
  | { readonly kind: "unknown" };

const peerBytes = (peer: PeerId): Uint8Array => hexToBytes(peer).unwrap();

export const grantFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.grant, wire]);

/** One signed custody receipt, on its way back to the author whose events it covers. */
export const receiptFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.receipt, wire]);

/** One signed refusal, on its way back to the author whose event was parked. */
export const refusalFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.refusal, wire]);

/** What a route advertisement carries on the wire: where to, how far, and until when. */
export interface RouteAdWire {
  readonly to: string;
  readonly hops: number;
  readonly expiresAtMs: number;
}

/**
 * The sender's reachable destinations. The next hop is **not** on the wire: it is whoever sent
 * the frame, which the receiving bridge already knows and a sender could otherwise lie about.
 */
export const routesFrame = (ads: readonly RouteAdWire[]): Uint8Array =>
  encodeCbor([KIND.routes, ads.map((ad) => [ad.to, ad.hops, ad.expiresAtMs])]);

export const grantRequestFrame = (peerId: PeerId, invite?: string): Uint8Array =>
  encodeCbor(
    invite === undefined
      ? [KIND.grantRequest, peerBytes(peerId)]
      : [KIND.grantRequest, peerBytes(peerId), invite],
  );

/**
 * Where the sender stands: `[kind, from, cursors, ahead?, floor?, schemaVersion?]`.
 *
 * The schema version sits at index 5 (D31), after D46's compaction floor at 4. An older build
 * reads index 3 strictly as `ahead` pairs and ignores the rest, so a sender with a version sends
 * `ahead` and the floor too, each as an empty array when it has nothing to say there — which a
 * receiver reads exactly as nothing said.
 */
export const cursorsFrame = (
  from: PeerId,
  cursors: Cursors,
  ahead?: Ahead,
  schemaVersion?: SchemaVersion,
): Uint8Array => {
  const base: CborValue[] = [KIND.cursors, peerBytes(from), cursorPairs(cursors)];
  if (schemaVersion !== undefined)
    return encodeCbor([...base, aheadPairs(ahead ?? new Map()), [], schemaVersion]);
  return encodeCbor(ahead === undefined ? base : [...base, aheadPairs(ahead)]);
};

export const eventFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.event, wire]);

/** What the sender may not send this peer, per author by sequence, under the entitlement `scope` (D40). */
export const withheldFrame = (scope: string, withheld: Ahead): Uint8Array =>
  encodeCbor([KIND.withheld, scope, aheadPairs(withheld)]);

export const presenceFrame = (wire: Uint8Array): Uint8Array => encodeCbor([KIND.presence, wire]);

/**
 * What the sender holds, and the two facts that make it comparable: the slice it counted
 * (`interestKey`) and the events it had folded when it counted them. A receiver differing on
 * either concludes nothing — which is what keeps a peer that is merely behind from looking
 * divergent.
 */
export const digestFrame = (
  scope: string,
  at: Cursors,
  digests: ReadonlyMap<string, bigint>,
  ahead?: Ahead,
): Uint8Array => {
  const base: CborValue[] = [
    KIND.digest,
    scope,
    cursorPairs(at),
    [...digests].map(([table, digest]): CborValue => [table, digest.toString(16)]),
  ];
  return encodeCbor(ahead === undefined ? base : [...base, aheadPairs(ahead)]);
};

export function decodeFrame(frame: Uint8Array): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(frame).mapError(
      (e) => new MalformedFrame({ message: e.message }),
    );
    if (!Array.isArray(outer) || outer.length < 2) return malformedFrame("expected [kind, …]");
    const [kind, payload, extra] = outer;
    if (
      kind === KIND.grant ||
      kind === KIND.event ||
      kind === KIND.presence ||
      kind === KIND.receipt ||
      kind === KIND.refusal
    ) {
      if (!(payload instanceof Uint8Array)) return malformedFrame("payload is not bytes");
      if (kind === KIND.grant) return Result.ok({ kind: "grant", wire: payload } as const);
      if (kind === KIND.event) return Result.ok({ kind: "event", wire: payload } as const);
      if (kind === KIND.receipt) return Result.ok({ kind: "receipt", wire: payload } as const);
      if (kind === KIND.refusal) return Result.ok({ kind: "refusal", wire: payload } as const);
      return Result.ok({ kind: "presence", wire: payload } as const);
    }
    return decodeTagged(kind, payload, extra, outer);
  });
}

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding CBOR is this file's I/O boundary: the checks below are the parse that gives the values a contract */
function decodeRoutes(payload: CborValue | undefined): Result<Frame, MalformedFrame> {
  if (!Array.isArray(payload)) return malformedFrame("routes payload is not a list");
  const ads: RouteAdWire[] = [];
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry.length < 3)
      return malformedFrame("route ad is not a triple");
    const [to, hops, expiresAtMs] = entry;
    if (typeof to !== "string") return malformedFrame("route destination is not text");
    if (!isSafeNonNegative(hops)) return malformedFrame("route hops is not a count");
    if (typeof expiresAtMs !== "number") return malformedFrame("route expiry is not a timestamp");
    ads.push({ to, hops, expiresAtMs });
  }
  return Result.ok({ kind: "routes", ads });
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The tags whose payload is structured; one this build does not know is ignored, never an error. */
function decodeTagged(
  kind: CborValue | undefined,
  payload: CborValue | undefined,
  extra: CborValue | undefined,
  outer: readonly CborValue[],
): Result<Frame | { readonly kind: "unknown" }, MalformedFrame> {
  if (kind === KIND.grantRequest) return decodeRequest(payload, extra);
  if (kind === KIND.cursors) return decodeCursors(payload, extra, outer[3], outer[5]);
  if (kind === KIND.digest) return decodeDigest(payload, extra, outer[3], outer[4]);
  if (kind === KIND.routes) return decodeRoutes(payload);
  if (kind === KIND.snapshot) return decodeSnapshotFrame(outer);
  if (kind === KIND.withheld) return decodeWithheld(payload, extra);
  return Result.ok({ kind: "unknown" } as const);
}

function decodeWithheld(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  if (!isString(payload)) return malformedFrame("withheld scope is not text");
  return decodeAheadPairs(extra).map(
    (withheld) => ({ kind: "withheld", scope: payload, withheld }) as const,
  );
}

function decodeRequest(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const peerId = yield* asPeer(payload);
    if (extra === undefined) return Result.ok({ kind: "grant-request", peerId } as const);
    if (!isString(extra)) return malformedFrame("invite is not text");
    return Result.ok({ kind: "grant-request", peerId, invite: extra } as const);
  });
}

function decodeDigest(
  payload: CborValue | undefined,
  at: CborValue | undefined,
  extra: CborValue | undefined,
  above: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  if (!isString(payload)) return malformedFrame("digest scope is not text");
  if (!Array.isArray(extra)) return malformedFrame("digests are not an array");
  const cursors = decodeCursorPairs(at);
  if (cursors.isErr()) return Result.err(cursors.error);
  const digests = new Map<string, bigint>();
  for (const pair of extra) {
    if (!Array.isArray(pair) || pair.length !== 2) return malformedFrame("digest is not a pair");
    const [table, hex] = pair;
    if (!isString(table) || !isString(hex)) return malformedFrame("digest is not [table, hex]");
    // a fingerprint that does not parse is one this build cannot compare; refusing the whole
    // frame is right, because a partial comparison would look like agreement it never checked
    const digest = Result.try({ try: () => BigInt(`0x${hex}`), catch: () => undefined });
    if (digest.isErr()) return malformedFrame("digest is not hexadecimal");
    digests.set(table, digest.value);
  }
  const base = { kind: "digest", scope: payload, at: cursors.value, digests } as const;
  if (above === undefined) return Result.ok(base);
  const ahead = decodeAheadPairs(above);
  return ahead.isErr() ? Result.err(ahead.error) : Result.ok({ ...base, ahead: ahead.value });
}

/**
 * Index 5 as this build reads it: a positive integer, or nothing. A value that is neither reads
 * as nothing rather than refusing the frame, as an older build reads it — the cursors beside it
 * are what the frame is for, and a reading is not worth losing them over.
 */
const frameSchemaVersion = (value: CborValue | undefined): SchemaVersion | undefined =>
  isSafeNonNegative(value) ? parseSchemaVersion(value).unwrapOr(undefined) : undefined;

function decodeCursors(
  payload: CborValue | undefined,
  extra: CborValue | undefined,
  above: CborValue | undefined,
  declared: CborValue | undefined,
): Result<Frame, MalformedFrame> {
  return Result.gen(function* () {
    const from = yield* asPeer(payload);
    const cursors = yield* decodeCursorPairs(extra);
    const base = { kind: "cursors", from, cursors } as const;
    if (above === undefined) return Result.ok(base);
    const ahead = yield* decodeAheadPairs(above);
    const schemaVersion = frameSchemaVersion(declared);
    return Result.ok(
      schemaVersion === undefined ? { ...base, ahead } : { ...base, ahead, schemaVersion },
    );
  });
}
