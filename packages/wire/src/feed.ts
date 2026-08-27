import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { parseSeqNum } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";
import type { Identity } from "./identity.js";

import { encodeCbor } from "./cbor.js";
import { bytesEqual, hexToBytes } from "./hex.js";
import { verify } from "./identity.js";

/**
 * One signature per run instead of per event (RFC-0019). Over BLE at 3–50 KB/s an Ed25519 check
 * per event is the cost that makes a join take minutes; over a chain it becomes one check for
 * the whole run.
 *
 * Each author folds its own events into a hash chain — `head(n) = sha256(head(n-1) ‖ core(n))` —
 * and signs only the head. A receiver holding the chain to seq `k` can take events `k+1…n`,
 * recompute forward, and check that one signature: if it matches, **every** event in the run is
 * this author's, because any substitution anywhere changes the head. Nothing is trusted that the
 * per-event signature would not also have proved; the arithmetic just moves.
 */

export class BrokenFeed extends TaggedError("BrokenFeed")<{
  peer: string;
  seq: number;
  message: string;
}> {}

/** The chain after an author's `seq`th event; `seq: 0` is where every feed begins. */
export interface FeedHead {
  readonly seq: SeqNum;
  readonly hash: Uint8Array;
}

/** No events yet: the chain starts from a fixed, empty hash rather than from nothing. */
export const GENESIS: FeedHead = {
  // SAFETY: zero is the seq before any event; parseSeqNum guards the numbers events carry, not this floor
  seq: 0 as SeqNum,
  hash: new Uint8Array(32),
};

/** One more event on the chain. The core bytes, never the envelope: a re-signed event is the same event. */
export function advanceFeed(head: FeedHead, core: Uint8Array): FeedHead {
  const joined = new Uint8Array(head.hash.length + core.length);
  joined.set(head.hash, 0);
  joined.set(core, head.hash.length);
  return {
    // SAFETY: a chain advances one event at a time, so the next seq is the previous plus one
    seq: (Number(head.seq) + 1) as SeqNum,
    hash: sha256(joined),
  };
}

const KEY = { v: 0, peerId: 1, seq: 2, head: 3 } as const;

/** What the author signs: the position and the chain hash there, and nothing else. */
const certificateCore = (peerId: PeerId, head: FeedHead): Uint8Array =>
  encodeCbor(
    new Map<CborKey, CborValue>([
      [KEY.v, 1],
      [KEY.peerId, hexToBytes(peerId).unwrap()],
      [KEY.seq, Number(head.seq)],
      [KEY.head, head.hash],
    ]),
  );

/**
 * An author's signed claim about its own feed: "at seq n my chain is this". It certifies every
 * event up to `n` at once, which is what lets a run of any length cost one verification.
 */
export interface FeedCertificate {
  readonly peerId: PeerId;
  readonly head: FeedHead;
  readonly sig: Uint8Array;
}

export const certifyFeed = (identity: Identity, head: FeedHead): FeedCertificate => ({
  peerId: identity.peerId,
  head,
  sig: identity.sign(certificateCore(identity.peerId, head)),
});

/** Whether this certificate is really the named author's. Cheap, and the only signature a run costs. */
export const certificateHolds = (certificate: FeedCertificate): boolean =>
  verify(
    certificateCore(certificate.peerId, certificate.head),
    certificate.sig,
    hexToBytes(certificate.peerId).unwrap(),
  );

/** A run of one author's consecutive events, and the certificate that covers where it ends. */
export interface FeedChunk {
  readonly peerId: PeerId;
  /** The seq this run starts *after*: a receiver needs its chain at exactly this point. */
  readonly from: SeqNum;
  /** Event cores in sequence order — the same bytes an envelope would carry, without the signatures. */
  readonly cores: readonly Uint8Array[];
  readonly certificate: FeedCertificate;
}

/**
 * Takes a run of the author's own events and the certificate for where it ends. Only the author
 * can build one: the chain is over its events and the signature is its own — a relay may store
 * and forward a chunk, and can never invent one.
 */
export function chunkFrom(
  identity: Identity,
  at: FeedHead,
  cores: readonly Uint8Array[],
): FeedChunk {
  let head = at;
  for (const core of cores) head = advanceFeed(head, core);
  return { peerId: identity.peerId, from: at.seq, cores, certificate: certifyFeed(identity, head) };
}

/**
 * The run, verified as one. Recomputes the chain from where the receiver already is, checks the
 * single signature over where it lands, and hands back the new head — which the receiver keeps
 * so the next run can start from it.
 *
 * A run that does not start where the receiver's chain does is refused rather than guessed at:
 * the gap is exactly what the chain exists to notice.
 */
export function verifyChunk(chunk: FeedChunk, at: FeedHead): Result<FeedHead, BrokenFeed> {
  const broken = (message: string) =>
    Result.err(new BrokenFeed({ peer: String(chunk.peerId), seq: Number(at.seq), message }));
  if (chunk.peerId !== chunk.certificate.peerId)
    return broken("the certificate names another author");
  if (Number(chunk.from) !== Number(at.seq))
    return broken(
      `the run starts after ${String(chunk.from)}, and this feed is at ${String(at.seq)}`,
    );
  let head = at;
  for (const core of chunk.cores) head = advanceFeed(head, core);
  if (Number(head.seq) !== Number(chunk.certificate.head.seq))
    return broken("the certificate covers a different position");
  if (!bytesEqual(head.hash, chunk.certificate.head.hash))
    return broken("the run does not lead to the certified head");
  if (!certificateHolds(chunk.certificate)) return broken("the certificate is not this author's");
  return Result.ok(head);
}

/** A head from its two stored halves, for a receiver that keeps chains across restarts. */
export const feedHeadOf = (seq: number, hash: Uint8Array): Result<FeedHead, BrokenFeed> =>
  parseSeqNum(seq)
    .map((parsed): FeedHead => ({ seq: parsed, hash }))
    .mapError((e) => new BrokenFeed({ peer: "", seq, message: e.message }));
