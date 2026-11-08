import type { PeerId, SchemaVersion, SyncEvent } from "@syncmesh/kernel";

import { eventSchemaVersion } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import type { Ack } from "./compaction.js";
import type { Unsubscribe } from "./listeners.js";
import type { Cursors } from "./sync.js";

import { createHub } from "./listeners.js";

/** The lowest schema an author was seen on, and the latest moment it was seen on it. */
export interface SchemaReading {
  readonly version: SchemaVersion;
  /** An event's own stamp, or when a cursors frame announced the version: never a guess. */
  readonly at: Temporal.Instant;
}

/**
 * Which readings count: those from `now - within` up to `now`. A reading stamped after `now` —
 * an author whose clock runs ahead, parked as `ClockAhead` — counts once `now` reaches it, so a
 * skewed stamp never stays inside every window. Absent, every one since boot.
 */
export interface FleetWindow {
  readonly now: Temporal.Instant;
  readonly within: Temporal.Duration;
}

/** What the engine knows about the peers around it: what they hold, and which builds they run. */
export interface FleetApi {
  /**
   * Records what `peer` holds, as of `at`; links call it on every cursor exchange. Feeds
   * `compact`, and with the `schemaVersion` the frame carried (D31), {@link FleetApi.oldestSchema}.
   */
  readonly acknowledge: (
    peer: PeerId,
    cursors: Cursors,
    at: Temporal.Instant,
    schemaVersion?: SchemaVersion,
  ) => void;
  /** What each peer was last acknowledged as holding. */
  readonly acks: () => ReadonlyMap<PeerId, Cursors>;
  /**
   * The same answer with the time it was given, which is the difference between "that peer is
   * behind" and "that peer has not been heard from since Tuesday". Both readings are diagnoses
   * and only one of them is about sync.
   *
   * {@link FleetApi.acks} stays as it is because nothing that consumes it — the compaction
   * floor, the link budget, churn — has any use for the stamp, and a Map they have to unwrap is
   * a cost paid on every sweep for one reader's benefit.
   */
  readonly acksAt: () => ReadonlyMap<PeerId, Ack>;
  /** Fires after `acknowledge` records what a peer holds. */
  readonly onAcknowledge: (listener: (peer: PeerId) => void) => Unsubscribe;
  /** What this build declares (D31): stamped on its events and sent on its cursors frames. */
  readonly schemaVersion?: SchemaVersion;
  /**
   * "The oldest schema still writing" (D31), per author: the lowest `schemaVersion` this device
   * has seen it on — on the events it folded or parked (absent reads as `1`) and on its cursors
   * frames — within `window`, or since boot without one. "Since boot" counts the events the
   * boot replay folds too, so without a window the reading also depends on how far the state
   * store's coverage lagged the log; pass a window for a reading about now.
   *
   * The event half is signed by its author; the cursors-frame half is the sender's claim, as
   * the acks are, so a linked peer can lower another author's reading, never raise it above
   * what that author's own events say. A relay's join frame carries no version and replaces the
   * joiner's last announcement until its next cursors frame, which a relay session sends once
   * its join has caught up: in between, the reading rests on that peer's events alone, and a
   * peer that wrote nothing drops out of it.
   *
   * The reading D31's rule waits on. A table or column is retired once every author that wrote in
   * the retention window reads at or above the version that stopped needing it, and an authority
   * correcting a column added in version *n* learns here which devices will fold the
   * `_corrections` row and not the value (gap-audit №20). Memory, like the acks: a device not
   * heard from since boot is not in it.
   */
  readonly oldestSchema: (window?: FleetWindow) => ReadonlyMap<PeerId, SchemaReading>;
}

/** The acks and the stamps, with the one write the fold path makes into them. */
export interface Fleet {
  readonly api: FleetApi;
  /** The acks as held, for the compaction floor. */
  readonly acks: ReadonlyMap<PeerId, Ack>;
  /** One event this device folded or parked: its author wrote under its stamped schema. */
  readonly note: (event: SyncEvent) => void;
}

/** Keeps the later of two instants: a reading is as fresh as the last time it was true. */
const later = (a: Temporal.Instant | undefined, b: Temporal.Instant): Temporal.Instant =>
  a === undefined || Temporal.Instant.compare(a, b) < 0 ? b : a;

/** Per author, the lowest version among `seen` and the acks' announcements inside the window. */
function lowest(
  seen: ReadonlyMap<PeerId, ReadonlyMap<SchemaVersion, Temporal.Instant>>,
  acks: ReadonlyMap<PeerId, Ack>,
  window: FleetWindow | undefined,
): ReadonlyMap<PeerId, SchemaReading> {
  const cutoff = window?.now.subtract(window.within);
  const readings = new Map<PeerId, SchemaReading>();
  const offer = (peer: PeerId, version: SchemaVersion, at: Temporal.Instant): void => {
    if (cutoff !== undefined && Temporal.Instant.compare(at, cutoff) < 0) return;
    if (window !== undefined && Temporal.Instant.compare(at, window.now) > 0) return;
    const held = readings.get(peer);
    if (held === undefined || version < held.version) readings.set(peer, { version, at });
    else if (version === held.version) readings.set(peer, { version, at: later(held.at, at) });
  };
  for (const [peer, versions] of seen)
    for (const [version, at] of versions) offer(peer, version, at);
  // an ack without a version is a build that announced none — a relay, or one from before D31 —
  // and says nothing about what it writes; its events, if it writes any, already did
  for (const [peer, ack] of acks)
    if (ack.schemaVersion !== undefined) offer(peer, ack.schemaVersion, ack.at);
  return readings;
}

/**
 * "The oldest schema still writing" (D31) beside the acknowledgements it reads with: per author,
 * per version, the newest stamp seen. Small by construction — an author writes under a handful
 * of versions over the life of a device.
 *
 * In memory, like the acknowledgements, so it is a reading of what this device has folded,
 * parked and been told since it booted. A device in a drawer is not in it; the retention window
 * is what covers that, not this.
 */
export function createFleet(
  schemaVersion: SchemaVersion | undefined,
  report: (cause: unknown) => void,
): Fleet {
  const acks = new Map<PeerId, Ack>();
  const heard = createHub<PeerId>(report);
  const seen = new Map<PeerId, Map<SchemaVersion, Temporal.Instant>>();
  const note = (event: SyncEvent): void => {
    const held = seen.get(event.peerId) ?? new Map<SchemaVersion, Temporal.Instant>();
    const version = eventSchemaVersion(event);
    held.set(version, later(held.get(version), event.hlc[0]));
    seen.set(event.peerId, held);
  };
  const api: FleetApi = {
    acknowledge: (peer, cursors, at, announced) => {
      acks.set(
        peer,
        announced === undefined ? { cursors, at } : { cursors, at, schemaVersion: announced },
      );
      heard.emit(peer);
    },
    acks: () => new Map([...acks].map(([peer, ack]) => [peer, ack.cursors])),
    acksAt: () => new Map(acks),
    onAcknowledge: heard.subscribe,
    ...(schemaVersion !== undefined && { schemaVersion }),
    oldestSchema: (window) => lowest(seen, acks, window),
  };
  return { api, acks, note };
}
