import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result, TaggedError, panic } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { isSafeNonNegative } from "./cbor-guards.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { MalformedEnvelope, splitEnvelope } from "./envelope.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";

/**
 * A signed acknowledgement of durable custody (book ch. 10): this peer has these events, on
 * disk, as of this storage incarnation.
 *
 * A cursor says the same thing and proves none of it — it is a number a peer sends about
 * itself, and a device counting copies off cursors is counting claims. A receipt is the claim
 * signed, so the count means something: the author can show which peers held its write, and a
 * peer that loses its log announces a **new incarnation**, which is what lets an author notice
 * that a copy it was counting is gone rather than believing a number that never moved.
 *
 * Delivery, never approval. Every receiver runs the same rules on the event itself; holding it
 * is not accepting it, and a receipt says nothing about whether the holder folded it.
 */
export interface CustodyReceipt {
  readonly v: 1;
  /** The peer vouching that it holds these events. */
  readonly holder: PeerId;
  /** Whose events; a receipt covers one author's contiguous run. */
  readonly author: PeerId;
  /** Everything of `author` up to and including this sequence is held. */
  readonly throughSeq: SeqNum;
  /**
   * The holder's storage lineage. A device that lost its database and rebuilt announces a fresh
   * one, so an author can tell "still holding" from "holding again, having lost what it had".
   */
  readonly incarnation: string;
  readonly issuedAt: Temporal.Instant;
}

const KEY = {
  v: 0,
  holder: 1,
  author: 2,
  throughSeq: 3,
  incarnation: 4,
  issuedAt: 5,
} as const;

export class MalformedReceipt extends TaggedError("MalformedReceipt")<{ message: string }> {}
export class BadReceiptSignature extends TaggedError("BadReceiptSignature")<{ message: string }> {}

export type ReceiptError = MalformedCbor | MalformedReceipt | BadReceiptSignature;

export function encodeReceipt(receipt: CustodyReceipt): Uint8Array {
  return encodeCbor(
    new Map<CborKey, CborValue>([
      [KEY.v, receipt.v],
      [KEY.holder, hexToBytes(receipt.holder).unwrap()],
      [KEY.author, hexToBytes(receipt.author).unwrap()],
      [KEY.throughSeq, receipt.throughSeq],
      [KEY.incarnation, receipt.incarnation],
      [KEY.issuedAt, receipt.issuedAt.epochMilliseconds],
    ]),
  );
}

export interface ReceiptRequest {
  readonly author: PeerId;
  readonly throughSeq: SeqNum;
  readonly incarnation: string;
  readonly now: Temporal.Instant;
}

/** Signs one, as wire bytes: `[core, sig]`, the envelope events, grants and checkpoints use. */
export function issueReceipt(holder: Identity, request: ReceiptRequest): Uint8Array {
  const core = encodeReceipt({
    v: 1,
    holder: holder.peerId,
    author: request.author,
    throughSeq: request.throughSeq,
    incarnation: request.incarnation,
    issuedAt: request.now,
  });
  return encodeCbor([core, holder.sign(core)]);
}

/**
 * Verifies against the received core bytes and against the holder the receipt names itself —
 * so a peer cannot hand over somebody else's receipt with its own signature, or its own with
 * somebody else's name. Never throws.
 */
export function verifyReceipt(wire: Uint8Array): Result<CustodyReceipt, ReceiptError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitReceipt(wire);
    const receipt = yield* decodeCbor(core).andThen(decodeReceiptValue);
    if (!verify(core, sig, hexToBytes(receipt.holder).unwrap())) {
      return Result.err(
        new BadReceiptSignature({
          message: "signature does not cover the received core, or is not the holder's",
        }),
      );
    }
    return Result.ok(receipt);
  });
}

const malformed = (message: string) => Result.err(new MalformedReceipt({ message }));

const splitReceipt = (wire: Uint8Array) =>
  splitEnvelope(wire).mapError((error) =>
    error instanceof MalformedEnvelope ? new MalformedReceipt({ message: error.message }) : error,
  );

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding CBOR is the I/O boundary: these checks are the parse */
function decodeReceiptValue(value: CborValue): Result<CustodyReceipt, MalformedReceipt> {
  if (!(value instanceof Map)) return malformed("receipt core is not a map");
  const holder = value.get(KEY.holder);
  const author = value.get(KEY.author);
  const throughSeq = value.get(KEY.throughSeq);
  const incarnation = value.get(KEY.incarnation);
  const issuedAt = value.get(KEY.issuedAt);
  if (!(holder instanceof Uint8Array) || !(author instanceof Uint8Array))
    return malformed("receipt names a peer it cannot read");
  if (typeof throughSeq !== "number") return malformed("throughSeq is not a sequence");
  if (typeof incarnation !== "string") return malformed("incarnation is not text");
  if (typeof issuedAt !== "number") return malformed("issuedAt is not a timestamp");

  const held = parsePeerId(bytesToHex(holder));
  if (held.isErr()) return malformed(held.error.message);
  const wrote = parsePeerId(bytesToHex(author));
  if (wrote.isErr()) return malformed(wrote.error.message);
  return Result.ok({
    v: 1,
    holder: held.value,
    author: wrote.value,
    // SAFETY: a SeqNum is a branded number, and this one was written from one by `issueReceipt`
    throughSeq: throughSeq as SeqNum,
    incarnation,
    issuedAt: Temporal.Instant.fromEpochMilliseconds(issuedAt),
  });
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Why a build could not take an event, in the three buckets a *later* build can act on (D13).
 * Coarse on purpose: the bound is per reason, so a reason has to name a class of parked event
 * whose cap means something. Declared here because a {@link RefusalReceipt} carries it.
 */
export type QuarantineReason =
  /** A table this build has no definition for — the shape a newer peer's new table arrives in. */
  | "unknown-table"
  /** A change kind this build cannot apply; the kernel would not know what to fold. */
  | "unknown-kind"
  /** The ladder refused it: grant, device, partition, schema or policy. An upgrade rarely helps. */
  | "refused";

const QUARANTINE_REASONS: ReadonlySet<string> = new Set<QuarantineReason>([
  "unknown-table",
  "unknown-kind",
  "refused",
]);

export const isQuarantineReason = (value: string): value is QuarantineReason =>
  QUARANTINE_REASONS.has(value);

/**
 * A verdict travels as a `ValidationError` tag and nothing longer: an identifier, never a
 * sentence. The author's own build owns the sentence (D32 §2).
 */
const VERDICT_TAG = /^[A-Z][A-Za-z0-9]{0,63}$/;

/**
 * The refusing twin of a {@link CustodyReceipt} (D32): this peer has the author's `(peer, seq)`,
 * will not fold it, and names the bucket and the verdict's tag.
 *
 * Information, never a veto. It cannot un-fold, block or supersede anything on any peer, and a
 * reader that gates on it turns a forgeable display into an attack on data. A later custody
 * receipt from the same refuser covering `seq` retires it. No free text: `verdict` is a tag.
 */
export interface RefusalReceipt {
  readonly v: 1;
  /** Who parked the event; the signature is checked against this key. */
  readonly refuser: PeerId;
  readonly author: PeerId;
  /** One event, not a run: a refusal is about one `(author, seq)`. */
  readonly seq: SeqNum;
  /** `unknown-table` and `unknown-kind` mean the refuser is on an older build, not that it said no. */
  readonly reason: QuarantineReason;
  /** The `ValidationError` tag — `GrantStale`, `PolicyDenied`, … */
  readonly verdict: string;
  readonly issuedAt: Temporal.Instant;
}

const REFUSAL_KEY = {
  v: 0,
  refuser: 1,
  author: 2,
  seq: 3,
  reason: 4,
  verdict: 5,
  issuedAt: 6,
} as const;

export function encodeRefusal(refusal: RefusalReceipt): Uint8Array {
  return encodeCbor(
    new Map<CborKey, CborValue>([
      [REFUSAL_KEY.v, refusal.v],
      [REFUSAL_KEY.refuser, hexToBytes(refusal.refuser).unwrap()],
      [REFUSAL_KEY.author, hexToBytes(refusal.author).unwrap()],
      [REFUSAL_KEY.seq, refusal.seq],
      [REFUSAL_KEY.reason, refusal.reason],
      [REFUSAL_KEY.verdict, refusal.verdict],
      [REFUSAL_KEY.issuedAt, refusal.issuedAt.epochMilliseconds],
    ]),
  );
}

export interface RefusalRequest {
  readonly author: PeerId;
  readonly seq: SeqNum;
  readonly reason: QuarantineReason;
  readonly verdict: string;
  readonly now: Temporal.Instant;
}

/**
 * Signs one, as wire bytes `[core, sig]`; the refuser is the signing identity, never a parameter.
 *
 * @throws {Panic} If `verdict` is not a tag — a sentence here is a definition mistake.
 */
export function issueRefusal(refuser: Identity, request: RefusalRequest): Uint8Array {
  if (!VERDICT_TAG.test(request.verdict))
    panic(`a refusal verdict is a tag, not ${JSON.stringify(request.verdict)}`);
  const core = encodeRefusal({
    v: 1,
    refuser: refuser.peerId,
    author: request.author,
    seq: request.seq,
    reason: request.reason,
    verdict: request.verdict,
    issuedAt: request.now,
  });
  return encodeCbor([core, refuser.sign(core)]);
}

/**
 * Verifies against the received core bytes and against the refuser the core names, the rule
 * {@link verifyReceipt} keeps. Never throws.
 */
export function verifyRefusal(wire: Uint8Array): Result<RefusalReceipt, ReceiptError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitReceipt(wire);
    const refusal = yield* decodeCbor(core).andThen(decodeRefusalValue);
    if (!verify(core, sig, hexToBytes(refusal.refuser).unwrap())) {
      return Result.err(
        new BadReceiptSignature({
          message: "signature does not cover the received core, or is not the refuser's",
        }),
      );
    }
    return Result.ok(refusal);
  });
}

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding CBOR is the I/O boundary: these checks are the parse */
function decodeRefusalValue(value: CborValue): Result<RefusalReceipt, MalformedReceipt> {
  if (!(value instanceof Map)) return malformed("refusal core is not a map");
  const refuser = value.get(REFUSAL_KEY.refuser);
  const author = value.get(REFUSAL_KEY.author);
  const seq = value.get(REFUSAL_KEY.seq);
  const reason = value.get(REFUSAL_KEY.reason);
  const verdict = value.get(REFUSAL_KEY.verdict);
  const issuedAt = value.get(REFUSAL_KEY.issuedAt);
  if (!(refuser instanceof Uint8Array) || !(author instanceof Uint8Array))
    return malformed("refusal names a peer it cannot read");
  if (!isSafeNonNegative(seq)) return malformed("seq is not a sequence");
  if (typeof reason !== "string" || !isQuarantineReason(reason))
    return malformed("reason is not a quarantine reason");
  if (typeof verdict !== "string" || !VERDICT_TAG.test(verdict))
    return malformed("verdict is not a tag");
  if (typeof issuedAt !== "number") return malformed("issuedAt is not a timestamp");

  const refused = parsePeerId(bytesToHex(refuser));
  if (refused.isErr()) return malformed(refused.error.message);
  const wrote = parsePeerId(bytesToHex(author));
  if (wrote.isErr()) return malformed(wrote.error.message);
  const numbered = parseSeqNum(seq);
  if (numbered.isErr()) return malformed("seq is not a sequence");
  // a fraction or an instant past Temporal's range throws; here it is a malformed refusal
  const issued = Result.try({
    try: () => Temporal.Instant.fromEpochMilliseconds(issuedAt),
    catch: () => new MalformedReceipt({ message: "issuedAt is not a timestamp" }),
  });
  if (issued.isErr()) return issued;
  return Result.ok({
    v: 1,
    refuser: refused.value,
    author: wrote.value,
    seq: numbered.value,
    reason,
    verdict,
    issuedAt: issued.value,
  });
}
/* oxlint-enable anti-slop/no-runtime-typeof */
