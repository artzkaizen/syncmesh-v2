import type { Cursors, EventStore, StoreFailure, StoredEvent } from "@syncmesh/engine";
import type { BlobHomes, BlobLedger, BlobStore } from "@syncmesh/storage";

import { Result, omitUndefined } from "@syncmesh/result";
import { memoryBlobHomes } from "@syncmesh/storage";
import { Temporal, addToInstant, durationMs } from "@syncmesh/temporal";

import type { BlobKeeper } from "./blob-keeper.js";
import type { RelayFrame } from "./frames.js";
import type { Conversation } from "./state.js";
import type { RelayTelemetry } from "./telemetry.js";

import { cappedBlobStore } from "./blob-cap.js";
import { createBlobKeeper } from "./blob-keeper.js";
import { helloFrame } from "./frames.js";

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
   * opened** — the cap counts what passes through it, so bytes already on disk at open are
   * outside the count until something touches them (the per-partition budget below does count
   * them, where the room has a ledger that has seen its whole log).
   *
   * Unlike the log, this one **has a default** ({@link DEFAULT_MAX_BLOB_BYTES}), and the asymmetry
   * is the point: blobs are content-addressed, so a room that drops them answers `blob-missing`
   * and whoever still holds the bytes puts them back. A trimmed event is gone from this hop for
   * good. One of those is a cache and one is a promise, so only one gets a default.
   *
   * `Infinity` says "keep every blob", deliberately and in writing.
   */
  readonly maxBlobBytes?: number;
  /**
   * How long a blob no live row references is kept, measured from its put — or from the delete
   * that released it, or from the room opening for one an earlier run left on disk (D18). Absent,
   * no blob is ever swept for being unreferenced — only the byte ceiling above removes any.
   *
   * A relay does not fold cells, so "references" is followed by row existence: a row that named
   * the hash holds it until a delete stamped after the row's latest write, and the references
   * outlive `keepEventsFor` trimming their events, kept in the room's blob ledger beside the
   * bytes. A sealed event keeps every blob put into its partition, and every blob put into none.
   * See `BlobKeeper` for the rest, all in the keeping direction.
   *
   * A blob swept too soon is a `blob-missing`, recoverable: anyone still holding the bytes puts
   * them back under the same name.
   */
  readonly keepUnreferencedBlobsFor?: Temporal.Duration;
  /**
   * The blob bytes one partition may hold here, refused at the put with a typed value — the
   * putter's `mesh.blobs.put` answers `BlobQuotaExceeded` and nothing is stored. Puts that name no
   * partition share one budget of the same size. Absent, there is no per-partition limit.
   *
   * Counted over the bytes this room holds — an earlier run's included, billed to one of their
   * homes, where the room's blob ledger has seen its whole log — and billed to the partition the
   * put claims — the relay has seen no row yet, so it is a budget, not a permission.
   * Any socket in the room can therefore spend another partition's budget by naming it; without
   * `keepUnreferencedBlobsFor` those bytes are never swept, and that partition's puts stay refused —
   * across a reopen too, where the room's ledger bills what an earlier run left on disk.
   */
  readonly maxBlobBytesPerPartition?: number;
  /**
   * How often the log and the blobs are swept. Default one minute; the log's half costs one
   * delete per author, the blobs' half one walk of the blobs admitted since open.
   */
  readonly sweepEvery?: Temporal.Duration;
}

/** Often enough that a duration cap is honest to within a minute, rarely enough to be free. */
export const DEFAULT_SWEEP = Temporal.Duration.from({ minutes: 1 });

/**
 * The blob bytes a room keeps when nobody said (gap audit №8): one gibibyte.
 *
 * Nominal, and it is a *ceiling* rather than a target — a room that never approaches it never
 * pays for it. It exists because the alternative default is unbounded disk, and for a cache
 * whose misses are recoverable that is the wrong way round.
 */
export const DEFAULT_MAX_BLOB_BYTES = 1024 * 1024 * 1024;

/**
 * A production retention policy, named so an operator can choose it rather than assemble it.
 *
 * Thirty days of log is the shape of the promise most rooms actually want: long enough that a
 * device off for a holiday still resumes from its cursors, short enough that disk is a function
 * of the write rate rather than of the room's age. **It stops being somewhere a new device can
 * bootstrap from history alone** — see {@link RelayRetention.keepEventsFor} — which is exactly
 * why it is a preset a person picks and not a default that picks itself.
 */
export const DURABLE_RETENTION = {
  keepEventsFor: Temporal.Duration.from({ days: 30 }),
  maxBlobBytes: DEFAULT_MAX_BLOB_BYTES,
} satisfies RelayRetention;

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
function trackAdmissions(keepFor: Temporal.Duration, booted: Mark): Admissions {
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

/**
 * Refuses a join whose cursors are below the room's floor, with a typed `retention` error that
 * names the floor, so the device can say what it is below and stop dialling (gaps U30). Whether
 * it refused.
 *
 * **Not a hang-up.** The room serves this device nothing, but it still takes what the device
 * hands it: the device sends everything it holds above the cursors the room's hello named, then
 * closes. A refusal that closed the socket kept every write the device made while away — and
 * every write it carried for a neighbour with no network — out of the room for as long as it
 * waited for state, which for a device that reaches the mesh only through this room was for
 * good, and nobody else was told (chaos soak, `--retention`, every seed with a relay-only sleeper).
 */
export function refusedBelowFloor(
  refuse: Conversation["refuse"],
  theirs: Cursors,
  floor: Cursors,
): boolean {
  if (!belowFloor(theirs, floor)) return false;
  refuse("retention", BELOW_FLOOR, false, floor);
  return true;
}

/**
 * A joiner below the floor: told the room's position and refused, but not hung up on, so what it
 * hands over still lands (see {@link refusedBelowFloor}). It takes no place among the room's
 * clients — no catch-up, no fan-out — and its seat's grant still bounds its blob puts (D44).
 */
export function handsOver(
  { room, sender, refuse }: Conversation,
  join: Extract<RelayFrame, { kind: "join" }> & { readonly selected: number },
): void {
  // a refused join is no seat: whatever this peer held here stops hearing the room, and a socket
  // it re-joined on stays open for the hand-over
  const old = room.clients.get(join.peerId);
  room.clients.delete(join.peerId);
  if (old !== undefined && old.sender !== sender) old.socket.close("superseded by a newer join");
  const { keepaliveMs, epoch, durable } = room;
  sender.send(helloFrame(join.selected, keepaliveMs, epoch, room.cursors(), room.floor(), durable));
  refusedBelowFloor(refuse, join.cursors, room.floor());
}

/** What a room lends its retention: the log, the bytes, where its ceiling is, and its clock. */
export interface RoomRetentionOptions {
  readonly store: EventStore;
  readonly policy: RelayRetention | undefined;
  /** The room's blob store, returned capped when there is a byte ceiling to apply to it. */
  readonly blobs: BlobStore | undefined;
  /** Where each blob may be read (D44), kept beside the bytes; absent, for this process only. */
  readonly homes: BlobHomes | undefined;
  /** What the blobs' rows referenced, kept beside the bytes (gaps U18); absent, for this process only. */
  readonly ledger: BlobLedger | undefined;
  /** What the room can serve right now; a sweep never trims above where this was a window ago. */
  readonly ceiling: () => Cursors;
  /** The floor the store booted with, before this room has swept anything. */
  readonly booted: Cursors;
  /**
   * The log as it was at open: what references the blobs at open, so a blob put again this run
   * under a name an old event carries is referenced, not free.
   */
  readonly held: readonly StoredEvent[];
  readonly now: () => Temporal.Instant;
  /** Runs the pass on the room's own queue, so the ceiling cannot move under it. */
  readonly serialize: (work: () => Promise<void>) => Promise<void>;
  /** Where a sweep says what it did — the room's telemetry seam (D17). */
  readonly report?: (event: RelayTelemetry) => void;
}

/** One room's retention, as the four things the room itself has to hold on to. */
export interface RoomRetention {
  /** The room's blob store with its cap applied, or exactly what was passed when there is none. */
  readonly blobs: BlobStore | undefined;
  readonly floor: () => Cursors;
  readonly sweep: () => Promise<void>;
  /** Stops the timer; the room's `close` owes this the way it owes the keepalive one. */
  readonly stop: () => void;
  /**
   * The blobs' obligations — quota, references, sweep — or absent for a room with no blob store.
   * The room feeds it every event it holds; puts go through it.
   */
  readonly keeper: BlobKeeper | undefined;
  /** This room keeps its log forever — reported once at open, never enforced. */
  readonly unbounded: boolean;
  /** The blob ceiling actually in force, default included. */
  readonly blobCeiling: number;
}

/**
 * The log and blob halves wired together, because a room needs them at the same moment and for
 * the same reason. A policy with neither half set costs a closure and no timer: nothing sweeps,
 * the blob store is passed through untouched, and the floor stays wherever the store left it.
 */
/** The room's blob store with its cap applied, and the keeper over it with the ledger read back. */
interface RoomBlobs {
  readonly blobs: BlobStore | undefined;
  readonly keeper: BlobKeeper | undefined;
}

/**
 * The blobs' half: the store capped at the ceiling, and its keeper told every reference the log
 * already holds and what the ledger kept of the ones it no longer does. Nothing for a room with
 * no blob store.
 */
async function openRoomBlobs(
  options: RoomRetentionOptions,
): Promise<Result<RoomBlobs, StoreFailure>> {
  const { policy } = options;
  const bytes = policy?.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (options.blobs === undefined) return Result.ok({ blobs: undefined, keeper: undefined });
  const blobs =
    bytes === Number.POSITIVE_INFINITY
      ? options.blobs
      : cappedBlobStore(options.blobs, bytes, (hash) => keeper.forget(hash));
  const keeper = createBlobKeeper({
    store: blobs,
    homes: options.homes ?? memoryBlobHomes(),
    quota: policy?.maxBlobBytesPerPartition,
    keepUnreferencedFor: policy?.keepUnreferencedBlobsFor,
    now: options.now,
    trimmedBefore: options.booted.size > 0,
    ...omitUndefined({ ledger: options.ledger }),
  });
  const opened = await keeper.open(options.held);
  return opened.map(() => ({ blobs, keeper }));
}

export async function roomRetention(
  options: RoomRetentionOptions,
): Promise<Result<RoomRetention, StoreFailure>> {
  const { store, policy, ceiling, now, serialize, report } = options;
  const keepFor = policy?.keepEventsFor;
  const keepBlobsFor = policy?.keepUnreferencedBlobsFor;
  const opened = await openRoomBlobs(options);
  if (opened.isErr()) return Result.err(opened.error);
  const { blobs, keeper } = opened.value;
  let floor = options.booted;
  // what was already on disk is marked as arriving now: no row records when it really did, and
  // guessing older would throw away a restarted room's whole log on its first pass
  const admitted =
    keepFor === undefined ? undefined : trackAdmissions(keepFor, { at: now(), cursors: ceiling() });

  /**
   * A failure leaves the floor where it was: refusing clients from a floor the log did not
   * actually move to would turn away devices this room can still serve in full.
   */
  const trim = async (): Promise<void> => {
    if (admitted === undefined) return;
    const at = now();
    const due = admitted.due(at);
    admitted.take(at, ceiling());
    if (due === undefined || due.size === 0) return;
    const swept = await trimLog(store, due);
    if (swept.isOk()) floor = swept.value;
  };
  /** The blobs' half, timed and reported in counts and bytes only (D48). */
  const sweepBlobs = async (): Promise<void> => {
    if (keeper === undefined) return;
    const started = Temporal.Now.instant();
    const done = await keeper.sweep();
    report?.({
      type: "relay.blob.sweep",
      sizes: done,
      duration: Temporal.Now.instant().since(started),
    });
  };
  // one pass on the room's queue for both halves. The references go to the ledger first, and a
  // trim waits for them: an event trimmed before what it named was saved would take that with it
  // at the next restart, and the blob a live row still names would be swept as unreferenced
  const pass = async (): Promise<void> => {
    const saved = (await keeper?.save()) ?? Result.ok(undefined);
    if (saved.isOk()) await trim();
    await sweepBlobs();
  };
  const sweep = () => serialize(pass);
  const timer =
    keepFor === undefined && keepBlobsFor === undefined
      ? undefined
      : setInterval(() => void sweep(), durationMs(policy?.sweepEvery ?? DEFAULT_SWEEP));

  return Result.ok({
    blobs,
    keeper,
    /** Whether this room keeps its log forever, for the one telemetry event that says so. */
    unbounded: keepFor === undefined,
    blobCeiling: policy?.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
    floor: () => floor,
    sweep,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  });
}
