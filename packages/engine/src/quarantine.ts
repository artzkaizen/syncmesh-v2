import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";
import { decodeEventCore, type QuarantineReason } from "@syncmesh/wire";

import type { ReceiveReport } from "./engine.js";
import type { ValidationError } from "./errors.js";
import type { StoreFailure, StoredEvent } from "./store.js";
import type { Cursors } from "./sync.js";

/**
 * Why a build could not take an event (D13), declared on the wire because a refusal receipt
 * carries it (D32). A newer build's change kind arrives as an `unknown` change carrying its tag
 * (D22-A), and the `unfoldable` rung in `admit` parks it as `unknown-kind`.
 */
export type { QuarantineReason };

/**
 * The bucket an event parks in: the {@link QuarantineReason}s a receipt carries, and one that
 * never leaves this device.
 *
 * `dropped-table` is an older build's write to a table this build dropped (D31). It has its own
 * bucket and its own cap, because sharing `unknown-table`'s would let an old fleet's ordinary
 * traffic evict the newer build's events that bucket is holding for the next upgrade. It stays
 * local because `verifyRefusal` drops a receipt whose reason it cannot name; a receipt says
 * `refused`, with the verdict's `TableDropped` tag (see {@link wireReason}).
 */
export type ParkReason = QuarantineReason | "dropped-table";

/** What a refusal receipt says for a bucket: `dropped-table` travels as `refused` (D31). */
export const wireReason = (reason: ParkReason): QuarantineReason =>
  reason === "dropped-table" ? "refused" : reason;

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
export const quarantineReason = (error: ValidationError): ParkReason => {
  if (error._tag === "UnknownTable") return "unknown-table";
  if (error._tag === "TableDropped") return "dropped-table";
  if (error._tag === "UnknownChangeKind") return "unknown-kind";
  return "refused";
};

/**
 * Whether a reason is one a later build could plausibly change its mind about: what
 * `unknownHandling` governs the telling of. A dropped table is not — the build that dropped it
 * is the later one — so it warns like a refusal does.
 */
export const isUnknown = (reason: ParkReason): boolean =>
  reason === "unknown-table" || reason === "unknown-kind";

/**
 * Whether new state could clear the verdict, which is what `withRetry` re-offers after a fold.
 * Only a refusal: no row landing teaches a build a table, or un-drops one.
 */
const clearedByState = (reason: ParkReason): boolean => reason === "refused";

/**
 * The verdicts the author's grant decides — the capability half of the ladder, as against its
 * rules. A newer grant for the author is new state for exactly these, which is what
 * {@link retryAuthor} re-offers on.
 */
export const CAPABILITY_VERDICTS = new Set<ValidationError["_tag"]>([
  "NoGrant",
  "GrantStale",
  "GrantRevoked",
  "GrantDeviceMismatch",
  "PartitionNotGranted",
]);

/**
 * One parked event: what arrived, and the verdict this build reached about it.
 *
 * `entry` is the {@link StoredEvent} as it was handed in — the author's own signature over the
 * author's own core bytes, never re-derived and never rebuilt from a partial parse, and never a
 * verdict written back into the event. The only thing that will ever understand a parked event is
 * a later build reading it, and a re-signed forgery of it is worth nothing to that build.
 *
 * The bytes are the point of the pair. `decodeEventCore` drops keys this build has no name for,
 * so `event` alone is what *this* build could read; `entry.core` is what the author signed, and a
 * build that knows the dropped key gets it back from there rather than from a re-encode. Both
 * transports keep the core they verified, so what reaches `park` from the wire has it. A row
 * written before the log kept arrival bytes holds a re-encode under the same column and parks
 * with that instead: what this build dropped was already gone when the row was written.
 *
 * An unknown *change kind* parks the same way: `decodeChange` keeps a tag it cannot name as an
 * `unknown` change (D22-A), so the event decodes, parks, and keeps the author's bytes beside it.
 */
export interface Parked {
  readonly entry: StoredEvent;
  readonly reason: ParkReason;
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
  reason: ParkReason;
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
  reason: ParkReason;
  message: string;
}> {}

export interface QuarantineOptions {
  /** Parked events kept per reason. `undefined` takes the default of 128; the oldest goes first, and says so. */
  readonly limit: number | undefined;
  readonly onEvict: (evicted: QuarantineEvicted) => void;
  /** This device's contiguous position per author; what `ahead` is reported relative to. */
  readonly cursors: () => Cursors;
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
  const { limit = DEFAULT_LIMIT, onEvict, cursors } = options;
  // insertion-ordered per reason, which is what "oldest first" means without reading a clock:
  // an eviction order taken from wall time would differ between two devices holding the same
  // events, and this store is already the last place that should depend on one
  const buckets = new Map<ParkReason, Map<string, Parked>>();
  const ensureBucket = (reason: ParkReason): Map<string, Parked> => {
    const held = buckets.get(reason) ?? new Map<string, Parked>();
    buckets.set(reason, held);
    return held;
  };

  return {
    park: (parked) => {
      const bucket = ensureBucket(parked.reason);
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
      const at = cursors();
      const seqs = new Map<PeerId, SeqNum[]>();
      for (const bucket of buckets.values()) {
        for (const { entry } of bucket.values()) {
          const { peerId, seqNum } = entry.event;
          // a snapshot install can adopt a coverage past something still parked here; saying we
          // hold it *above* our cursor would then be a claim about a position we are already past
          if (Number(seqNum) <= Number(at.get(peerId) ?? 0)) continue;
          const held = seqs.get(peerId) ?? [];
          held.push(seqNum);
          seqs.set(peerId, held);
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
/**
 * The parked events new state could plausibly clear, re-offered; the rest left where they are.
 *
 * What {@link retryQuarantined} is for a build upgrade, this is for a fold. `unknown-table`,
 * `unknown-kind` and `dropped-table` say this build cannot read the event at all, and no row
 * landing next to it changes that — re-offering them costs a walk and, worse, reports each one as newly refused
 * every time a batch lands. `refused` is the ladder's verdict on the state at the time, and
 * state moves: the row an update patches may have arrived in the batch that just folded.
 */
export function retryRefused(
  parked: QuarantineStore,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
): Promise<Result<ReceiveReport, StoreFailure>> {
  return retryWhere(parked, ({ reason }) => clearedByState(reason), receive);
}

/**
 * One author's events parked on a {@link CAPABILITY_VERDICTS capability verdict}, re-offered; the
 * rest left where they are. What a grant registering for that author calls (gaps U42).
 *
 * An event that arrives before its author's grant is parked `NoGrant`, and the grant is new state
 * that no fold announces: over any path where grants and events travel separately — two relay
 * instances, a relay and a radio — the grant can land second, and in a quiet room no later batch
 * would ever run {@link withRetry} for it. Only the capability verdicts are re-offered, because
 * a grant decides nothing else; whatever the ladder still refuses is parked again.
 */
export function retryAuthor(
  parked: QuarantineStore,
  author: PeerId,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
): Promise<Result<ReceiveReport, StoreFailure>> {
  return retryWhere(
    parked,
    ({ entry, verdict }) => entry.event.peerId === author && CAPABILITY_VERDICTS.has(verdict._tag),
    receive,
  );
}

/** The parked events `which` picks, re-offered; the store keeps the rest, and the picked ones if the batch fails. */
async function retryWhere(
  parked: QuarantineStore,
  which: (held: Parked) => boolean,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
): Promise<Result<ReceiveReport, StoreFailure>> {
  const held = parked.take();
  const retry = held.filter(which);
  // back first, so a store emptied by `take` is whole again before anything can fail
  for (const entry of held) if (!which(entry)) parked.park(entry);
  if (retry.length === 0) return Result.ok({ folded: 0, skipped: 0, quarantined: 0 });
  const report = await receive(retry.map(({ entry }) => reread(entry)));
  if (report.isErr()) for (const entry of retry) parked.park(entry);
  return report;
}

export async function retryQuarantined(
  parked: QuarantineStore,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
): Promise<Result<ReceiveReport, StoreFailure>> {
  const held = parked.take();
  if (held.length === 0) return Result.ok({ folded: 0, skipped: 0, quarantined: 0 });
  const report = await receive(held.map(({ entry }) => reread(entry)));
  if (report.isErr()) for (const entry of held) parked.park(entry);
  return report;
}

/** The engine's two re-offers over one store: every parked event, and one author's capability verdicts. */
export const createRetries = (
  parked: QuarantineStore,
  receive: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
) => ({
  retryQuarantined: () => retryQuarantined(parked, receive),
  retryAuthor: (author: PeerId) => retryAuthor(parked, author, receive),
});

/**
 * The entry as *this* build reads it, rather than as the build that parked it did.
 *
 * `entry.event` is a decode, and a decode drops every key its build had no name for. Keeping the
 * author's core is only worth anything if something reads it again, and this is the only place
 * that does: a build that has since learned the key gets it back here or nowhere. The bytes are
 * untouched and the signature beside them still covers them, so this re-reads rather than
 * re-derives — a re-encode of what the old build could see is exactly what the core is kept to
 * avoid.
 *
 * An entry with no core came from a local write, which never met a codec; there is nothing to
 * re-read and the event as held is the whole of it. So is a core this build cannot decode at
 * all, which would be a build that got worse rather than better.
 */
const reread = (entry: StoredEvent): StoredEvent =>
  entry.core === undefined
    ? entry
    : decodeEventCore(entry.core)
        .map((event): StoredEvent => ({ ...entry, event }))
        .unwrapOr(entry);

/**
 * A batch, then another look at what new state could have cleared.
 *
 * A refusal is a verdict on the state at the time, and state moves. The common case is an update
 * whose row arrives in a later page than the update itself: refused on the way past, then correct
 * the moment the insert lands, with nothing to notice that it turned. Parked events are never
 * re-offered on their own, so without this the event stays refused for the life of the device
 * while the row it needs sits in the table beside it.
 *
 * Gated on `folded`, which is what makes it terminate: a retry runs only after a batch admitted
 * something new, and a retry that admits nothing folds nothing and so asks for no other. The
 * latch keeps the retry's own batch from walking the store a second time.
 */
export function withRetry(
  receiveBatch: (entries: readonly StoredEvent[]) => Promise<Result<ReceiveReport, StoreFailure>>,
  parked: QuarantineStore,
) {
  let retrying = false;
  const receive = async (
    entries: readonly StoredEvent[],
  ): Promise<Result<ReceiveReport, StoreFailure>> => {
    const report = await receiveBatch(entries);
    if (retrying || report.isErr() || report.value.folded === 0) return report;
    if (parked.list().length === 0) return report;
    retrying = true;
    try {
      const again = await retryRefused(parked, receive);
      if (again.isErr()) return report;
      // `folded` grows because those events did land on this call; `quarantined` and `skipped`
      // stay the batch's own, since a retry re-offers what an earlier call already counted
      return Result.ok({
        folded: report.value.folded + again.value.folded,
        skipped: report.value.skipped,
        quarantined: report.value.quarantined,
      });
    } finally {
      retrying = false;
    }
  };
  return receive;
}
