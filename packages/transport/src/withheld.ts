import type { Snapshot } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";

/**
 * The authority-visibility tables (D24), as a link that is **not** the authority's gate sees them:
 * rows it never carries. A clinic phone must not be able to pull a patient's record from another
 * clinic's phone because the two happened to meet, and nothing on a device can say whether the
 * far side was admitted — only the authority can, and it answers through the relay.
 */
export interface Withheld {
  /** The gated tables, by name. */
  readonly tables: ReadonlySet<string>;
  /**
   * Whose run their events sit in: the authority, their only author. A snapshot served over this
   * link claims nothing of that run, because it is missing rows the run wrote and a cursor past
   * them would skip them on every later catch-up.
   */
  readonly author: PeerId | undefined;
}

/** Whether a link withholding `withheld` must not carry this event. */
export const withholds = (withheld: Withheld | undefined, event: SyncEvent): boolean =>
  withheld !== undefined &&
  withheld.tables.size > 0 &&
  event.changes.some((change) => withheld.tables.has(change.table));

/** A table's digest, unless it is gated: two devices admitted different rows are not divergent. */
export const openDigests = (
  withheld: Withheld | undefined,
  digests: ReadonlyMap<string, bigint>,
): ReadonlyMap<string, bigint> =>
  withheld === undefined || withheld.tables.size === 0
    ? digests
    : new Map([...digests].filter(([table]) => !withheld.tables.has(table)));

/**
 * The snapshot a peer may be served: no gated rows, and no claim over the authority's run — its
 * events are re-offered as history instead, which a gated relay filters and says how far it
 * scanned (D23), and which a peer link withholds again.
 */
export const servable = (withheld: Withheld | undefined, snapshot: Snapshot): Snapshot => {
  if (withheld === undefined || withheld.tables.size === 0) return snapshot;
  const rows = snapshot.rows.filter((row) => !withheld.tables.has(row.table));
  const author = withheld.author;
  if (author === undefined) return { ...snapshot, rows };
  const synced = new Map(snapshot.coverage.synced);
  synced.delete(author);
  return { ...snapshot, rows, coverage: { ...snapshot.coverage, synced } };
};
