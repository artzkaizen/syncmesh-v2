import type {
  EventId,
  Hlc,
  PartitionKey,
  PeerId,
  SeqNum,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { compareHlc } from "@syncmesh/kernel";
import { encodeEventCore } from "@syncmesh/wire";

import type { EventStore, StoreFailure, StoredEvent } from "./store.js";

/**
 * Reading the log as a log — newest first, a page at a time, and never the contents.
 *
 * The only read the engine had was `eventsSince`, and it is anti-entropy's: ordered by author
 * and sequence because that is how a peer walks a run, unbounded because a peer wants everything
 * it lacks, and blind to local writes because no peer is owed them. Every one of those is wrong
 * for a person asking what this device has been doing, and the last one is the worst — the
 * writes a developer is most often chasing are the ones that never left.
 */

/**
 * One event as a reader may see it, with the author's bytes left where they are.
 *
 * The type is the whole of the protection. What a log viewer wants is the *shape* of the
 * traffic — who wrote, how often, how large, into which instance — and none of that needs the
 * contents; handing back a {@link StoredEvent} would put somebody's rows on a screen as a side
 * effect of counting them. A header cannot: there is no core here, no signature, and nothing
 * that can be decoded back into either.
 */
export interface EventHeader {
  readonly id: EventId;
  /** Who wrote it — this device for its own writes, and somebody else for everything that arrived. */
  readonly peer: PeerId;
  readonly seq: SeqNum;
  readonly hlc: Hlc;
  /** The instance the write belongs to; absent for a global table. */
  readonly partition: PartitionKey | undefined;
  /** A write that never leaves this device, numbered in its own sequence namespace. */
  readonly local: boolean;
  /** What the event costs the log — the stored core's length, and never a word of what it says. */
  readonly bytes: number;
  /**
   * The tables the event wrote, where they can be had for nothing.
   *
   * A store that already holds decoded events answers; one over a database does not, because
   * the only way to name a table there is to read the core back — which is the single thing a
   * header exists to avoid, and which would cost a decode per row of a panel that refreshes on
   * every fold. A sealed event answers nothing either, for the plainer reason that this device
   * cannot read it. Absent is that fact, in both cases, and not an event that wrote nowhere.
   */
  readonly tables: readonly TableName[] | undefined;
}

/**
 * Which page of the tail to read.
 *
 * The cursor is a stamp rather than an offset because the log has no offsets: events arrive out
 * of order and land between ones already stored, so a page numbered from the end would shuffle
 * under a reader who is paging while a batch comes in. A stamp names a place the log agrees on.
 */
export interface RecentEvents {
  /** How many headers at most. Default {@link DEFAULT_RECENT}. */
  readonly limit?: number;
  /**
   * Strictly below this stamp — hand back the last header of the page you have, and the next one
   * follows it.
   *
   * Two devices can stamp the same millisecond and counter without ever having met, so a page
   * boundary landing exactly on a shared stamp drops its twin. Carrying the author and sequence
   * in the cursor would close that, at the price of a cursor a caller has to assemble rather
   * than one it already holds; the paging is a log viewer's, and a stamp collision inside a
   * hundred-event page is rarer than the reader scrolling past it.
   */
  readonly before?: Hlc;
}

/** A page nobody sized: enough to fill a screen, few enough that a store need not think about it. */
export const DEFAULT_RECENT = 100;

/** Newest first, which is the order a log is read in and the reverse of the order it is written in. */
const byStampDescending = (left: EventHeader, right: EventHeader): number =>
  compareHlc(right.hlc, left.hlc);

const tablesOf = (event: SyncEvent): readonly TableName[] | undefined =>
  event.sealed === true ? undefined : [...new Set(event.changes.map((change) => change.table))];

/**
 * One stored entry as a header.
 *
 * An own write is in the log before anything has signed it, so it carries no core and the length
 * is taken by encoding one — the same bytes a SQL store writes into its `core` column on the way
 * in, so the number means the same thing wherever the log happens to live.
 */
export const headerOf = (entry: StoredEvent): EventHeader => ({
  id: entry.event.id,
  peer: entry.event.peerId,
  seq: entry.event.seqNum,
  hlc: entry.event.hlc,
  partition: entry.event.partition,
  local: entry.event.local === true,
  bytes: (entry.core ?? encodeEventCore(entry.event)).length,
  tables: tablesOf(entry.event),
});

/**
 * The tail by stamp, for a store with no page of its own.
 *
 * It reads the whole log and keeps a hundred of it, which is exactly the cost
 * {@link EventStore.recent} exists to avoid — and is the honest answer for a store whose events
 * are already objects in memory, where there was never a cheaper read to find. A store over a
 * database says so by answering `recent` itself; this is what runs when nothing there can.
 */
export function recentHeaders(
  store: EventStore,
  options: RecentEvents = {},
): Promise<Result<readonly EventHeader[], StoreFailure>> {
  const { limit = DEFAULT_RECENT, before } = options;
  return store.all().then((held) =>
    held.map((entries) =>
      entries
        .map(headerOf)
        .filter((header) => before === undefined || compareHlc(header.hlc, before) < 0)
        .sort(byStampDescending)
        .slice(0, limit),
    ),
  );
}
