import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { ReceiveReport } from "./engine.js";
import type { ValidationError } from "./errors.js";
import type { StoreFailure, StoredEvent } from "./store.js";

/**
 * Why a build could not take an event, in the three buckets a *later* build can act on (D13).
 * Coarse on purpose: the bound is per reason, so a reason has to name a class of parked event
 * whose cap means something. A hundred rows of one forged author must not be able to push out
 * the one event from a newer app version that this device is holding for its next upgrade.
 */
export type QuarantineReason =
  /** A table this build has no definition for — the shape a newer peer's new table arrives in. */
  | "unknown-table"
  /** A change kind this build cannot apply; the kernel would not know what to fold. */
  | "unknown-kind"
  /** The ladder refused it: grant, device, partition, schema or policy. An upgrade rarely helps. */
  | "refused";

/**
 * What a mesh does about an event no build here can read (D13) — **per mesh, never per event**,
 * because two peers choosing differently is the divergence the additive rule exists to prevent.
 *
 * All three park the event and none of them fold it, so the setting cannot move a row: it
 * decides how loudly the device says so, and nothing else. That is stronger than D13 asks for,
 * and deliberately: a knob that could change what folds would be a divergence waiting for the
 * first mesh whose devices were configured by two different people.
 */
export type UnknownHandling =
  /** Park it and report it on `onQuarantine`. The default. */
  | "warn"
  /** Park it and stay quiet — for an app that has nothing to do about it until it updates. */
  | "ignore"
  /** Park it, report it, and raise it on `onError` as well, where a test will trip over it. */
  | "fail";

/** Which bucket a verdict parks in. */
export const quarantineReason = (error: ValidationError): QuarantineReason => {
  if (error._tag === "UnknownTable") return "unknown-table";
  if (error._tag === "UnknownChangeKind") return "unknown-kind";
  return "refused";
};

/** Whether a reason is one a later build could plausibly change its mind about. */
export const isUnknown = (reason: QuarantineReason): boolean => reason !== "refused";

/**
 * One parked event: what arrived, and the verdict this build reached about it.
 *
 * `entry` is the {@link StoredEvent} exactly as it was handed in — the author's own signature
 * over the author's own bytes, never re-derived and never rebuilt from a partial parse. That is
 * the whole point of parking rather than dropping: the only thing that will ever understand this
 * event is a later build reading these same bytes, and a re-signed forgery of them is worth
 * nothing to it.
 */
export interface Parked {
  readonly entry: StoredEvent;
  readonly reason: QuarantineReason;
  /** What this build made of it. A later build may reach a different verdict on the same bytes. */
  readonly verdict: ValidationError;
}

/**
 * A parked event was dropped to keep the store bounded. Loud on purpose: this is data the device
 * was explicitly holding on to, and the peer that sent it has long since been told we hold up to
 * our cursor — so nothing will offer it again unless the gap below it is still open.
 */
export class QuarantineEvicted extends TaggedError("QuarantineEvicted")<{
  peer: PeerId;
  seqNum: SeqNum;
  reason: QuarantineReason;
  message: string;
}> {}

/**
 * `unknownHandling: "fail"` and an event this build cannot read arrived. Raised on `onError`
 * rather than returned from `receiveBatch`, whose error channel belongs to the store (D05): a
 * peer sending something newer is not a reason the batch failed to land, and every event beside
 * it did land.
 */
export class UnreadableEvent extends TaggedError("UnreadableEvent")<{
  peer: PeerId;
  seqNum: SeqNum;
  reason: QuarantineReason;
  message: string;
}> {}

export interface QuarantineOptions {
  /** Parked events kept per reason. `undefined` takes the default of 128; the oldest goes first, and says so. */
  readonly limit: number | undefined;
  readonly onEvict: (evicted: QuarantineEvicted) => void;
}

export interface QuarantineStore {
  /** Parks an event, replacing any earlier parking of the same one; evicts the oldest if full. */
  readonly park: (parked: Parked) => void;
  readonly list: () => readonly Parked[];
  /** Every parked event, removed — what `retryQuarantined` re-offers to the ordinary path. */
  readonly take: () => readonly Parked[];
  /** Per author, the sequence numbers held here above the device's cursor. */
  readonly ahead: () => ReadonlyMap<PeerId, readonly SeqNum[]>;
}

const DEFAULT_LIMIT = 128;

/**
 * The parked events, in their own store rather than in the log: an event the ladder refused is
 * not a fact this device holds, and serving it to a third peer would spread whatever the refusal
 * was about. Bounded per reason, oldest first, and never silently — see {@link QuarantineEvicted}.
 */
export function createQuarantine(options: QuarantineOptions): QuarantineStore {
  const { limit = DEFAULT_LIMIT, onEvict } = options;
  // insertion-ordered per reason, which is what "oldest first" means without reading a clock:
  // an eviction order taken from wall time would differ between two devices holding the same
  // events, and this store is already the last place that should depend on one
  const buckets = new Map<QuarantineReason, Map<string, Parked>>();
  const bucketOf = (reason: QuarantineReason): Map<string, Parked> => {
    const held = buckets.get(reason) ?? new Map<string, Parked>();
    buckets.set(reason, held);
    return held;
  };

  return {
    park: (parked) => {
      const bucket = bucketOf(parked.reason);
      bucket.delete(parked.entry.event.id);
      bucket.set(parked.entry.event.id, parked);
      while (bucket.size > limit) {
        const oldest = bucket.values().next().value;
        if (oldest === undefined) break;
        bucket.delete(oldest.entry.event.id);
        onEvict(
          new QuarantineEvicted({
            peer: oldest.entry.event.peerId,
            seqNum: oldest.entry.event.seqNum,
            reason: oldest.reason,
            message: `quarantine full at ${limit} for ${oldest.reason}; the oldest parked event was dropped`,
          }),
        );
      }
    },
    list: () => [...buckets.values()].flatMap((bucket) => [...bucket.values()]),
    take: () => {
      const held = [...buckets.values()].flatMap((bucket) => [...bucket.values()]);
      buckets.clear();
      return held;
    },
    ahead: () => {
      const seqs = new Map<PeerId, SeqNum[]>();
      for (const bucket of buckets.values()) {
        for (const { entry } of bucket.values()) {
          const held = seqs.get(entry.event.peerId) ?? [];
          held.push(entry.event.seqNum);
          seqs.set(entry.event.peerId, held);
        }
      }
      for (const held of seqs.values()) held.sort((a, b) => a - b);
      return seqs;
    },
  };
}

/**
 * Re-offers every parked event to the ordinary receive path — what an app calls after an update
 * that might understand them. Nothing special happens to them there: they go through the same
 * ladder as any peer's events, and whatever still cannot be read is simply parked again, so a
 * retry that helps nothing costs nothing but the walk.
 *
 * The store is emptied first and refilled if the batch could not land, because a parked event
 * that is neither in the quarantine nor in the log is the one outcome this whole store exists
 * to prevent.
 */
export async function retryQuarantined(
  parked: QuarantineStore,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
): Promise<Result<ReceiveReport, StoreFailure>> {
  const held = parked.take();
  if (held.length === 0) return Result.ok({ folded: 0, skipped: 0, quarantined: 0 });
  const report = await receive(held.map(({ entry }) => entry));
  if (report.isErr()) for (const entry of held) parked.park(entry);
  return report;
}
