import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
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
      [KEY.throughSeq, Number(receipt.throughSeq)],
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
