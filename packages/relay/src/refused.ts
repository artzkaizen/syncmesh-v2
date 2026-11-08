import type { Coverage, FoldBatch, PurgeScope, StoredEvent } from "@syncmesh/engine";
import type {
  EventId,
  Hlc,
  PeerId,
  RowRecord,
  Stamp,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { entitles, matchesInterest } from "@syncmesh/engine";
import { compareHlc, getRecord, eventStamp } from "@syncmesh/kernel";
import { withholds } from "@syncmesh/transport";
import { decodeEventCore, splitEnvelope } from "@syncmesh/wire";

import type { JoinedScope } from "./scoped.js";

/**
 * What a re-page from nothing proved this device is now refused (D24, D45): every held event of
 * another device that writes a gated table, that this join asked for and its grant covers, that
 * the room scanned — it stands inside the coverage the last page named — and that the room did
 * not send again. The room withheld it; the authority's gate no longer admits this device to it.
 *
 * Inside the coverage, and only there: an event the room never held, or one it holds and can
 * never send, stops the scanned run at the hole below it, so nothing above a hole is judged.
 * An event the room did send whose signature failed here is not refused either: it was sent.
 */
const refusedIn = (
  context: TransportContext,
  held: readonly StoredEvent[],
  scoped: Coverage,
  asked: JoinedScope,
  sent: ReadonlySet<EventId>,
): readonly StoredEvent[] => {
  const own = context.grants.grantFor(context.identity.peerId)?.partitions;
  return held.filter(
    ({ event }) =>
      event.peerId !== context.identity.peerId &&
      withholds(context.withheld, event) &&
      event.seqNum <= (scoped.synced.get(event.peerId) ?? 0) &&
      matchesInterest(asked.sent, event) &&
      (own === undefined || entitles(own, event)) &&
      !sent.has(event.id),
  );
};

/** The gated tables a set of refused events wrote: what the app is told it lost rows of. */
const tablesOf = (context: TransportContext, refused: readonly StoredEvent[]): TableName[] => {
  const gated = context.withheld?.tables ?? new Set<string>();
  const tables = new Set<TableName>();
  for (const { event } of refused)
    for (const change of event.changes) if (gated.has(change.table)) tables.add(change.table);
  return [...tables];
};

/**
 * The event an envelope claims to be, without judging its signature: what a re-page sent and this
 * device could not verify. Read only to keep the claim out of the refused set — a forged claim
 * can make this device keep an event, never purge one.
 */
const claimedId = (wire: Uint8Array): EventId | undefined => {
  const split = splitEnvelope(wire);
  if (split.isErr()) return undefined;
  const event = decodeEventCore(split.value.core);
  return event.isOk() ? event.value.id : undefined;
};

/** Folds that bring rows from elsewhere: a late copy of a refused row is purged on arrival. */
const ARRIVALS = new Set<FoldBatch["source"]>(["remote", "snapshot", "repair"]);

/** What was refused, with the stamps its events wrote per author: what marks a row as carrying it. */
const remembered = (events: readonly SyncEvent[]): Refused => {
  const stamps = new Map<PeerId, Hlc[]>();
  for (const event of events) {
    const stamp = eventStamp(event);
    stamps.set(stamp.peer, [...(stamps.get(stamp.peer) ?? []), stamp.hlc]);
  }
  return { events, ids: new Set(events.map((event) => event.id)), stamps };
};

/** Whether a row carries content one of the refused events wrote: a cell or its write stamped by one. */
const carries = (record: RowRecord, stamps: ReadonlyMap<PeerId, readonly Hlc[]>): boolean => {
  const refused = (stamp: Stamp | undefined): boolean =>
    stamp !== undefined &&
    (stamps.get(stamp.peer) ?? []).some((hlc) => compareHlc(hlc, stamp.hlc) === 0);
  if (refused(record.writeStamp)) return true;
  for (const cell of record.cells.values()) if (refused(cell.stamp)) return true;
  return false;
};

/** What the last re-page refused, kept so a late copy of it is purged on arrival. */
interface Refused {
  readonly events: readonly SyncEvent[];
  readonly ids: ReadonlySet<EventId>;
  readonly stamps: ReadonlyMap<PeerId, readonly Hlc[]>;
}

/**
 * The row-level purge (D45), for one relay link: each session notes what a re-page from nothing
 * delivers, and once that re-page ends with a coverage naming an entitlement, what the room
 * withheld is purged — through the mesh, which tells the app first, or the engine directly when
 * the transport runs without one.
 *
 * What was refused is remembered across sessions, until the next re-page from nothing judges again.
 * A row carrying it that arrives after the purge — a snapshot, a repair, an event in flight — is
 * purged on arrival, without telling the app a second time.
 *
 * Two things a re-page did not send again are not refusals, and are kept: an event the room holds
 * and can never send (no envelope), which stops the room's scanned coverage below it, and an event
 * the room sent whose signature failed here, which is said through `dropped`.
 *
 * @param dropped - Where a failure to read the log or to purge is said; the session carries on.
 */
export function refusalsOver(context: TransportContext, dropped: (why: string) => void) {
  let refused = remembered([]);
  /** Late purges, one after another, and after the session purge that remembered them. */
  let late: Promise<void> = Promise.resolve();

  const purge = async (tables: readonly TableName[], what: Refused): Promise<void> => {
    const scope = {
      events: (event) => what.ids.has(event.id),
      rows: (record) => carries(record, what.stamps),
    } satisfies PurgeScope;
    if (context.purge !== undefined) {
      await context.purge({ partitions: [], tables }, scope);
      return;
    }
    const purged = await context.engine.purge(scope);
    if (purged.isErr()) dropped(`what was refused could not be purged: ${purged.error.message}`);
  };

  /** Whether a fold wrote a row carrying what was refused. */
  const wroteRefused = (batch: FoldBatch): boolean => {
    const state = context.engine.state();
    for (const [table, keys] of batch.writeKeys)
      for (const key of keys) {
        const record = getRecord(state, table, key);
        if (record !== undefined && carries(record, refused.stamps)) return true;
      }
    return false;
  };

  const offFolds = context.engine.onFoldBatch((batch) => {
    if (refused.ids.size === 0 || !ARRIVALS.has(batch.source) || !wroteRefused(batch)) return;
    // told already: the app heard of these tables when they were first refused
    const what = refused;
    late = late.then(() => purge([], what));
  });

  /** One session's notes on what its re-page delivered. */
  const session = () => {
    const sent = new Set<EventId>();
    const unverified = new Set<EventId>();
    return {
      /** A re-page delivered this event: admitted again, so no longer remembered as refused. */
      delivered: (id: EventId): void => {
        sent.add(id);
        if (refused.ids.has(id)) refused = remembered(refused.events.filter((e) => e.id !== id));
      },
      /** A re-page sent these bytes and their signature failed here: kept, never taken as refused. */
      unverified: (wire: Uint8Array): void => {
        const id = claimedId(wire);
        if (id !== undefined) unverified.add(id);
      },
      /** The re-page ended under an entitlement: purge what it did not send again. */
      repaged: async (scoped: Coverage, asked: JoinedScope): Promise<void> => {
        const delivered = new Set([...sent, ...unverified]);
        const failed = unverified.size;
        sent.clear();
        unverified.clear();
        if (context.withheld === undefined || context.withheld.tables.size === 0) return;
        const held = await context.engine.eventsSince(new Map());
        if (held.isErr()) {
          dropped(`the log could not be read to purge what was refused: ${held.error.message}`);
          return;
        }
        if (failed > 0)
          dropped(
            `${failed} event(s) the re-page sent failed to verify here; they are kept, not purged as refused`,
          );
        const found = refusedIn(context, held.value, scoped, asked, delivered);
        // judged again from nothing: what this re-page did not refuse is no longer remembered
        refused = remembered(found.map(({ event }) => event));
        if (found.length > 0) await purge(tablesOf(context, found), refused);
      },
    };
  };

  return {
    session,
    /** Stops watching for late arrivals, and settles once the late purges already begun are done. */
    stop: (): Promise<void> => {
      offFolds();
      return late;
    },
  };
}

/** One session's half of {@link refusalsOver}. */
export type SessionRefusals = ReturnType<ReturnType<typeof refusalsOver>["session"]>;
