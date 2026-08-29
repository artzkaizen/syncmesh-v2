import type { Engine } from "@syncmesh/engine";
import type { Hlc, PeerId, RowKey, SeqNum, TableName } from "@syncmesh/kernel";

import { getRecord } from "@syncmesh/kernel";

/**
 * Where a row's write has reached, from this device's point of view (D26).
 *
 * There is deliberately no `"rejected"`. A peer that quarantines an event holds its cursor below
 * it forever (`transport/holdback.ts`) and never reports the refusal to the author, so a refused
 * write is indistinguishable from one still in flight — naming a state for it would be inventing
 * a fact the system cannot observe.
 */
export type SyncState =
  /** This device wrote it and no peer has acknowledged the event yet. */
  | "local"
  /** This device wrote it and at least one peer's cursors cover the event. */
  | "delivered"
  /** Another peer wrote it; delivery is not this device's question, as it is not for a received message. */
  | "remote";

/** A stamp's clock, as a map key. */
const hlcKey = (hlc: Hlc): string => `${String(hlc[0].epochMilliseconds)}:${String(hlc[1])}`;

export interface SyncStates {
  /** `undefined` when the row is absent, or was never written through an event with a stamp. */
  readonly at: (table: TableName, key: RowKey) => SyncState | undefined;
  readonly stop: () => void;
}

/**
 * Answers `$sync` per row without a sidecar table.
 *
 * A record carries the stamp of the write that won it — `{ hlc, peer }` — and the peer alone
 * settles `"remote"`. Telling `"local"` from `"delivered"` needs the event's **sequence number**,
 * which a stamp does not carry, so this keeps the one thing that is missing: `hlc → seq` for this
 * device's own events that no peer has acknowledged yet. That map is bounded by the outbox, not
 * by the table, and it empties as acknowledgements arrive.
 *
 * A stamp with no entry reads as `"delivered"`: the map holds exactly the unacknowledged ones, so
 * anything absent has either been acknowledged or been compacted away, and compaction only
 * removes what every peer already holds.
 *
 * Local-only tables are out of scope — their events never leave the device, so the question has
 * no answer rather than the answer `"local"`.
 */
export function createSyncStates(engine: Engine, self: PeerId): SyncStates {
  const unacknowledged = new Map<string, SeqNum>();

  /** The highest sequence of this device's own events that any peer says it holds. */
  const ackedThrough = (): number => {
    let highest = 0;
    for (const cursors of engine.acks().values())
      highest = Math.max(highest, Number(cursors.get(self) ?? 0));
    return highest;
  };

  const prune = (): void => {
    const floor = ackedThrough();
    for (const [at, seq] of unacknowledged) if (Number(seq) <= floor) unacknowledged.delete(at);
  };

  /**
   * The tail a previous run left behind: events this device authored and shut down before any
   * peer acknowledged. Once only — every event authored while this process lives arrives on
   * `onOutbound` instead.
   */
  const recover = async (): Promise<void> => {
    // every other peer at its current position, so only this device's own tail comes back
    const theirs = new Map(engine.coverage().synced);
    // SAFETY: `ackedThrough` reads sequence numbers out of the acknowledged cursors and returns one of them (or 0, the floor)
    const floor = ackedThrough() as SeqNum;
    theirs.set(self, floor);
    const events = await engine.eventsSince(theirs);
    if (events.isErr()) return;
    for (const { event } of events.value)
      if (event.peerId === self) unacknowledged.set(hlcKey(event.hlc), event.seqNum);
    prune();
  };

  void recover();
  const offOutbound = engine.onOutbound((event) =>
    unacknowledged.set(hlcKey(event.hlc), event.seqNum),
  );
  const offAck = engine.onAcknowledge(prune);

  return {
    at: (table, key) => {
      const record = getRecord(engine.state(), table, key);
      const stamp = record?.writeStamp;
      if (stamp === undefined) return undefined;
      if (stamp.peer !== self) return "remote";
      const seq = unacknowledged.get(hlcKey(stamp.hlc));
      if (seq === undefined) return "delivered";
      return Number(seq) <= ackedThrough() ? "delivered" : "local";
    },
    stop: () => {
      offOutbound();
      offAck();
    },
  };
}
