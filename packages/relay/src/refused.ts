import type { Coverage, PurgeScope, StoredEvent } from "@syncmesh/engine";
import type { EventId, TableName } from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { entitles, matchesInterest } from "@syncmesh/engine";
import { withholds } from "@syncmesh/transport";

import type { JoinedScope } from "./scoped.js";

/**
 * What a re-page from nothing proved this device is now refused (D24, D45): every held event of
 * another device that writes a gated table, that this join asked for and its grant covers, that
 * the room scanned — it stands inside the coverage the last page named — and that the room did
 * not send again. The room withheld it; the authority's gate no longer admits this device to it.
 *
 * Inside the coverage, and only there: an event the room never held stops the scanned run at the
 * hole below it, so nothing above a hole is judged.
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
 * One session's half of the row-level purge (D45): it notes every event a re-page from nothing
 * delivers, and once that re-page ends with a coverage naming an entitlement, purges what the
 * room withheld — through the mesh, which tells the app first, or the engine directly when the
 * transport runs without one.
 *
 * @param dropped - Where a failure to read the log or to purge is said; the session carries on.
 */
export function refusedOnRepage(context: TransportContext, dropped: (why: string) => void) {
  const sent = new Set<EventId>();
  return {
    /** A re-page delivered this event. */
    delivered: (id: EventId): void => void sent.add(id),
    /** The re-page ended under an entitlement: purge what it did not send again. */
    repaged: async (scoped: Coverage, asked: JoinedScope): Promise<void> => {
      const delivered = new Set(sent);
      sent.clear();
      if (context.withheld === undefined || context.withheld.tables.size === 0) return;
      const held = await context.engine.eventsSince(new Map());
      if (held.isErr()) {
        dropped(`the log could not be read to purge what was refused: ${held.error.message}`);
        return;
      }
      const refused = refusedIn(context, held.value, scoped, asked, delivered);
      if (refused.length === 0) return;
      const ids = new Set(refused.map(({ event }) => event.id));
      const scope = { events: (event) => ids.has(event.id) } satisfies PurgeScope;
      if (context.purge !== undefined) {
        await context.purge({ partitions: [], tables: tablesOf(context, refused) }, scope);
        return;
      }
      const purged = await context.engine.purge(scope);
      if (purged.isErr()) dropped(`what was refused could not be purged: ${purged.error.message}`);
    },
  };
}
