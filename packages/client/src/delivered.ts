import type { Cursors, Engine } from "@syncmesh/engine";
import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";

import { parseEventId } from "@syncmesh/kernel";
import { panic } from "@syncmesh/result";

export interface DeliveredOptions {
  /** A specific event; omitted, every synced write this device has made so far. */
  readonly event?: EventId;
  /** The peer that must hold it; omitted, any peer counts. */
  readonly to?: PeerId;
}

const covered = (cursors: Cursors | undefined, peer: PeerId, seq: SeqNum): boolean =>
  (cursors?.get(peer) ?? 0) >= seq;

/**
 * `mesh.delivered`: a promise that settles once a peer's acknowledged cursors cover the target.
 * Delivery, not approval — every receiver runs the same policy itself; an authority's verdict
 * is E12/E16's to add.
 */
export function createDelivered(
  engine: Engine,
  self: PeerId,
): (options?: DeliveredOptions) => Promise<void> {
  const targetOf = (event: EventId | undefined) => {
    if (event === undefined) {
      const seq = engine.coverage().synced.get(self);
      return seq === undefined ? undefined : { peer: self, seq };
    }
    const parsed = parseEventId(String(event));
    if (parsed.isErr()) return panic(`${String(event)}: ${parsed.error.message}`);
    if (parsed.value.local)
      return panic(`${String(event)}: a local event never leaves this device`);
    return { peer: parsed.value.peerId, seq: parsed.value.seqNum };
  };

  return (options = {}) => {
    const target = targetOf(options.event);
    if (target === undefined) return Promise.resolve();
    const satisfied = (): boolean => {
      const acks = engine.acks();
      if (options.to !== undefined) return covered(acks.get(options.to), target.peer, target.seq);
      return [...acks.values()].some((cursors) => covered(cursors, target.peer, target.seq));
    };
    if (satisfied()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = engine.onAcknowledge(() => {
        if (!satisfied()) return;
        off();
        resolve();
      });
    });
  };
}
