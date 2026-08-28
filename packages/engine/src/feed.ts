import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { FeedCertificate, FeedChunk, FeedHead } from "@syncmesh/wire";

import { Result as R } from "@syncmesh/result";
import {
  BrokenFeed,
  GENESIS,
  advanceFeed,
  decodeEventCore,
  encodeEventCore,
  verifyChunk,
} from "@syncmesh/wire";

import type { ReceiveReport } from "./engine.js";
import type { EventStore, StoreFailure, StoredEvent } from "./store.js";

/**
 * The engine's half of RFC-0019's feed chains: a chain tracked per author as events fold, runs
 * assembled from the log, and a run verified once instead of once per event.
 *
 * The chain is only meaningful over a contiguous run, which is exactly what the bridge's gap rule
 * already guarantees — an event that arrives out of order is held back rather than folded, so a
 * head only ever advances by one.
 *
 * **What a chunk proves, and what it does not.** One certificate proves every event in the run is
 * that author's. It says nothing about whether the author was *allowed* to write them, so each
 * event still goes through the ordinary ladder — grant, partition, schema, policy — before it is
 * stored. The saving is cryptographic, never a relaxation of the rules.
 */

/** What a device knows about one author's chain: where it is, and the best certificate it holds. */
export interface FeedState {
  readonly head: FeedHead;
  readonly certificate?: FeedCertificate;
}

export interface FeedTracker {
  /**
   * Advances the chain for an event this device has folded; out-of-order is refused, not guessed.
   *
   * The **entry**, not the event: the chain is a hash of the bytes the author signed, and this
   * build re-encoding what it could read of a newer peer's event would compute a different chain
   * from the author's own — every run that peer serves would then fail to reach its certified
   * head. An own write carries no core yet, and re-encoding it is exactly what `signEvent` will
   * do, so the two agree by construction.
   */
  readonly note: (entry: StoredEvent) => void;
  /** The chain this device has computed for an author; `GENESIS` for one it has never heard from. */
  readonly head: (peer: PeerId) => FeedHead;
  /** The best certificate held for an author — what lets this device serve a run for it. */
  readonly certificate: (peer: PeerId) => FeedCertificate | undefined;
  /** Keeps a certificate if it covers more of the author's feed than the one already held. */
  readonly remember: (certificate: FeedCertificate) => void;
}

/**
 * Heads live in memory. A boot refolds the log through `fold`, so a device with no state store
 * rebuilds every chain it can walk contiguously from genesis; one that boots from persisted state
 * replays only the tail above it, and `note` refuses a run that does not start where the chain is,
 * so those heads stay at `GENESIS` until the author's next event lands. That is the honest place
 * for them for now, because the case chunks exist for is a **join** — a device with no events,
 * whose head genuinely is genesis for every author. A device that falls back to per-event
 * verification pays in speed and never in correctness.
 */
export function trackFeeds(): FeedTracker {
  const heads = new Map<PeerId, FeedHead>();
  const certificates = new Map<PeerId, FeedCertificate>();
  return {
    note: ({ event, core }) => {
      const at = heads.get(event.peerId) ?? GENESIS;
      // a chain advances one event at a time; anything else leaves it where it was, and a later
      // chunk starting elsewhere is refused rather than silently accepted from the wrong place
      if (Number(event.seqNum) !== Number(at.seq) + 1) return;
      heads.set(event.peerId, advanceFeed(at, core ?? encodeEventCore(event)));
    },
    head: (peer) => heads.get(peer) ?? GENESIS,
    certificate: (peer) => certificates.get(peer),
    remember: (certificate) => {
      const held = certificates.get(certificate.peerId);
      if (held !== undefined && Number(held.head.seq) >= Number(certificate.head.seq)) return;
      certificates.set(certificate.peerId, certificate);
    },
  };
}

export interface ChunkDeps {
  readonly store: EventStore;
  readonly feeds: FeedTracker;
  /** The ordinary receive path: a chunk's events are admitted exactly as any other peer's are. */
  readonly receiveBatch: (
    entries: readonly StoredEvent[],
  ) => Promise<Result<ReceiveReport, StoreFailure>>;
}

/**
 * One author's events above `from`, with the certificate that covers where they end — a run any
 * receiver on the same chain can take in one verification.
 *
 * `undefined` when this device holds no certificate for that author: it may have the events and
 * still be unable to prove the run, which is a fact about what it was told, not a failure.
 */
export async function chunkSince(
  deps: ChunkDeps,
  peer: PeerId,
  from: SeqNum,
): Promise<Result<FeedChunk | undefined, StoreFailure>> {
  const certificate = deps.feeds.certificate(peer);
  if (certificate === undefined) return R.ok(undefined);
  const entries = await deps.store.allSince(new Map([[peer, from]]));
  if (entries.isErr()) return entries;
  const cores = entries.value
    .filter(
      ({ event }) => event.peerId === peer && Number(event.seqNum) <= Number(certificate.head.seq),
    )
    .sort((a, b) => Number(a.event.seqNum) - Number(b.event.seqNum))
    // the bytes the author signed, never this build's reading of them: the certificate covers a
    // chain over the originals, and a re-encode would not lead to the head it certifies
    .map(({ event, core }) => core ?? encodeEventCore(event));
  return R.ok({ peerId: peer, from, cores, certificate });
}

/**
 * A run, verified once and then handed to the ordinary receive path. The single signature replaces
 * the per-event ones and nothing else changes: grant, partition, schema and policy all still run,
 * so a chunk cannot smuggle in a write its author was not allowed to make.
 */
export async function receiveChunk(
  deps: ChunkDeps,
  chunk: FeedChunk,
): Promise<Result<ReceiveReport, StoreFailure | BrokenFeed>> {
  const at = deps.feeds.head(chunk.peerId);
  const verified = verifyChunk(chunk, at);
  if (verified.isErr()) return verified;

  const entries: StoredEvent[] = [];
  for (const core of chunk.cores) {
    const decoded = decodeEventCore(core);
    // the run verified, so an unreadable core is a build this device cannot read, not a forgery
    if (decoded.isErr())
      return R.err(
        new BrokenFeed({
          peer: String(chunk.peerId),
          seq: Number(at.seq),
          message: decoded.error.message,
        }),
      );
    // the arrival bytes are kept even though no per-event signature came with them: they are what
    // the chain is over, so a run this device serves on carries the author's cores and not its own
    entries.push({ event: decoded.value, core });
  }
  const received = await deps.receiveBatch(entries);
  if (received.isErr()) return received;
  deps.feeds.remember(chunk.certificate);
  return received;
}

/** What an engine offers for taking a run at a time rather than an event at a time (RFC-0019). */
export interface FeedApi {
  /**
   * A run of one author's events above `from`, with the certificate covering where it ends.
   * `undefined` when this device holds no certificate for that author.
   */
  readonly chunkSince: (
    peer: PeerId,
    from: SeqNum,
  ) => Promise<Result<FeedChunk | undefined, StoreFailure>>;
  /** Verifies a run once, then admits every event in it through the ordinary receive path. */
  readonly receiveChunk: (
    chunk: FeedChunk,
  ) => Promise<Result<ReceiveReport, StoreFailure | BrokenFeed>>;
  /** This device's computed chain for an author — where a run must start, and what to certify. */
  readonly feedHead: (peer: PeerId) => FeedHead;
  /** Keeps an author's certificate, so this device can serve runs for it. */
  readonly rememberCertificate: (certificate: FeedCertificate) => void;
}

/** Both halves against one engine's log, so `createEngine` states the wiring once. */
export const createFeedPath = (deps: ChunkDeps): FeedApi => ({
  chunkSince: (peer, from) => chunkSince(deps, peer, from),
  receiveChunk: (chunk) => receiveChunk(deps, chunk),
  feedHead: deps.feeds.head,
  rememberCertificate: deps.feeds.remember,
});
