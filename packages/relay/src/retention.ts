import type { Cursors, EventStore, StoreFailure } from "@syncmesh/engine";
import type { BlobStore } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";
import { Temporal, addToInstant, durationMs } from "@syncmesh/temporal";

import { cappedBlobStore } from "./blob-cap.js";

/**
 * What a room stops keeping, and when. Every field is absent by default, and absent is what
 * every relay did before this: the log grows forever and the blob table with it.
 *
 * The two halves are not the same kind of promise, which is why they are separate fields rather
 * than one number. Blobs are content-addressed, so dropping them costs nothing that cannot be
 * put back — a `blob-missing` is a value the fetcher acts on. A trimmed event is gone from this
 * hop for good, and the room has to say so.
 */
export interface RelayRetention {
  /**
   * How long an event stays servable here, measured from when **this room admitted it** — never
   * from the stamp its author put on it. See {@link trackAdmissions} for why the difference is a
   * convergence bug and not a rounding one. Absent, the log keeps everything.
   *
   * Turning this on changes what the room is: it stops being somewhere a **new** device can
   * bootstrap from history alone, because the prefix a new device needs is exactly the prefix
   * that gets trimmed. Such a device must adopt a peer's snapshot first (RFC-0019) and only then
   * join. A device whose own contiguous cursor is at or above the floor is unaffected; one below
   * it is refused with a typed `retention` error rather than paged a hole, and its reconnect
   * succeeds the moment it has filled the gap from somewhere else.
   *
   * A device that joined with an `Interest` is the exception, and D23 is why: its contiguous
   * cursor pins below the first event the relay filtered out, so a rising floor eventually
   * refuses it on every join even though it is current on everything it asked for. D23 decided
   * the fix — a filtered catch-up hands back a coverage scoped to that interest — and until that
   * is built, a room that trims and a client that narrows do not belong together.
   *
   * It bounds disk against a write rate rather than against a number of events: at a steady rate
   * the log settles at rate × this duration. A count or byte ceiling would need the `EventStore`
   * to be able to say how many entries it holds, and it cannot.
   */
  readonly keepEventsFor?: Temporal.Duration;
  /**
   * A ceiling on the blob bytes this room holds, over the bytes it has admitted **since it was
   * opened** — the `BlobStore` port cannot enumerate what a previous run left behind, so bytes
   * already on disk at open are outside the count until something touches them.
   */
  readonly maxBlobBytes?: number;
  /** How often the log is swept. Default one minute; the sweep costs one delete per author. */
  readonly sweepEvery?: Temporal.Duration;
}

/** Often enough that a duration cap is honest to within a minute, rarely enough to be free. */
export const DEFAULT_SWEEP = Temporal.Duration.from({ minutes: 1 });

/**
 * Past every stamp an event can carry: the age this cut measures is the room's, not the author's,
 * so `compactBelow`'s stamp half is opened all the way and the sequence ceiling carries the whole
 * decision. The one shape it cannot reach is an event stamped at the very top of the representable
 * range, because the store's predicate is strict — noted rather than worked around, since a stamp
 * that far ahead is a problem for the fold long before it is one for the disk.
 */
const ANY_STAMP = Temporal.Instant.fromEpochMilliseconds(8_640_000_000_000_000);

/** Samples per window: an event is kept for `keepEventsFor`, and at most an eighth longer. */
const MARK_STEPS = 8;

/**
 * One retention pass, and the room's new floor. Everything at or below `ceiling` goes, which is a
 * **prefix** of each author's run, because a cursor map is contiguous by construction.
 *
 * The floor comes back from the store rather than from the ceiling that produced it, because the
 * store is what remembers it across a restart — a floor kept only in memory would be a floor the
 * next boot advertised as zero while the log below it was already gone.
 */
export async function trimLog(
  store: EventStore,
  ceiling: Cursors,
): Promise<Result<Cursors, StoreFailure>> {
  const removed = await store.compactBelow(ceiling, "synced", ANY_STAMP);
  if (removed.isErr()) return Result.err(removed.error);
  const floors = await store.compactedBelow();
  return floors.map((coverage) => coverage.synced);
}

/** Where the room's log reached, and when it reached there. */
interface Mark {
  readonly at: Temporal.Instant;
  readonly cursors: Cursors;
}

/** What a room remembers about when it admitted the run it is holding. */
export interface Admissions {
  /** Records where the ceiling is now, no more often than one step of the window. */
  readonly take: (at: Temporal.Instant, cursors: Cursors) => void;
  /**
   * The newest ceiling that has been here for the whole window, or `undefined` while none has.
   * Everything at or below it arrived at least `keepEventsFor` ago.
   */
  readonly due: (at: Temporal.Instant) => Cursors | undefined;
}

/**
 * When the room admitted what it holds, sampled on the room's own clock.
 *
 * This is the whole reason retention is not one comparison against `hlc_ms`. That column is the
 * **author's** stamp: a device that wrote offline, or one whose clock runs behind, hands over an
 * event that is already older than the window the moment it arrives. Cutting on that stamp sweeps
 * it away in the very next pass — while `hello` goes on advertising it in the room's cursors, so
 * its author never re-pushes it, and every peer that still needs it is refused at the floor. Two
 * honest peers, both connected and both willing, then never converge. Sampling arrival instead
 * makes `keepEventsFor` a promise the room can actually keep.
 *
 * The samples are the ceiling, not the events: at most {@link MARK_STEPS} + 1 cursor maps, whatever
 * the traffic. The price is the granularity — an event is kept for the window and up to one step
 * more — and entries already in the log when the room opened are marked as arriving at that
 * moment, since nothing on disk records when they really did.
 */
export function trackAdmissions(keepFor: Temporal.Duration, booted: Mark): Admissions {
  const stepMs = durationMs(keepFor) / MARK_STEPS;
  const marks: Mark[] = [booted];
  return {
    take: (at, cursors) => {
      const last = marks.at(-1);
      if (last !== undefined && at.since(last.at).total({ unit: "milliseconds" }) < stepMs) return;
      marks.push({ at, cursors });
    },
    due: (at) => {
      const cut = addToInstant(at, keepFor.negated());
      let due: Mark | undefined;
      // the newest sample old enough to have aged out; the ones under it can never be the answer
      while (marks.length > 0 && Temporal.Instant.compare(marks[0]?.at ?? at, cut) <= 0)
        due = marks.shift();
      // it stays at the head: it is still the answer until a younger sample ages in behind it
      if (due !== undefined) marks.unshift(due);
      return due?.cursors;
    },
  };
}

/** Said in one place, because the join checks the floor and the catch-up behind it checks again. */
export const BELOW_FLOOR = "this room no longer holds the history below the cursors you sent";

/**
 * The author whose history this client asked for and the room no longer holds — `true` when any
 * cursor it offered sits below the floor. A client at exactly the floor is fine: catch-up serves
 * what is **above** a cursor, and the floor is the last sequence that is gone.
 */
export function belowFloor(theirs: Cursors, floor: Cursors): boolean {
  for (const [author, seq] of floor) {
    if (Number(theirs.get(author) ?? 0) < Number(seq)) return true;
  }
  return false;
}

/** What a room lends its retention: the log, the bytes, where its ceiling is, and its clock. */
export interface RoomRetentionOptions {
  readonly store: EventStore;
  readonly policy: RelayRetention | undefined;
  /** The room's blob store, returned capped when there is a byte ceiling to apply to it. */
  readonly blobs: BlobStore | undefined;
  /** What the room can serve right now; a sweep never trims above where this was a window ago. */
  readonly ceiling: () => Cursors;
  /** The floor the store booted with, before this room has swept anything. */
  readonly booted: Cursors;
  readonly now: () => Temporal.Instant;
  /** Runs the pass on the room's own queue, so the ceiling cannot move under it. */
  readonly serialize: (work: () => Promise<void>) => Promise<void>;
}

/** One room's retention, as the four things the room itself has to hold on to. */
export interface RoomRetention {
  /** The room's blob store with its cap applied, or exactly what was passed when there is none. */
  readonly blobs: BlobStore | undefined;
  readonly floor: () => Cursors;
  readonly sweep: () => Promise<void>;
  /** Stops the timer; the room's `close` owes this the way it owes the keepalive one. */
  readonly stop: () => void;
}

/**
 * The log and blob halves wired together, because a room needs them at the same moment and for
 * the same reason. A policy with neither half set costs a closure and no timer: nothing sweeps,
 * the blob store is passed through untouched, and the floor stays wherever the store left it.
 */
export function roomRetention(options: RoomRetentionOptions): RoomRetention {
  const { store, policy, ceiling, now, serialize } = options;
  const keepFor = policy?.keepEventsFor;
  const bytes = policy?.maxBlobBytes;
  let floor = options.booted;
  // what was already on disk is marked as arriving now: no row records when it really did, and
  // guessing older would throw away a restarted room's whole log on its first pass
  const admitted =
    keepFor === undefined ? undefined : trackAdmissions(keepFor, { at: now(), cursors: ceiling() });

  /**
   * A failure leaves the floor where it was: refusing clients from a floor the log did not
   * actually move to would turn away devices this room can still serve in full.
   */
  const pass = async (): Promise<void> => {
    if (admitted === undefined) return;
    const at = now();
    const due = admitted.due(at);
    admitted.take(at, ceiling());
    if (due === undefined || due.size === 0) return;
    const swept = await trimLog(store, due);
    if (swept.isOk()) floor = swept.value;
  };
  const sweep = () => serialize(pass);
  const timer =
    keepFor === undefined
      ? undefined
      : setInterval(() => void sweep(), durationMs(policy?.sweepEvery ?? DEFAULT_SWEEP));

  return {
    blobs:
      options.blobs === undefined || bytes === undefined
        ? options.blobs
        : cappedBlobStore(options.blobs, bytes),
    floor: () => floor,
    sweep,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
