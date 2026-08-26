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

export interface ReceivedOptions {
  /** The event this engine must have folded — a peer's, typically the authority's reply to a procedure. */
  readonly event: EventId;
}

const covered = (cursors: Cursors | undefined, peer: PeerId, seq: SeqNum): boolean =>
  (cursors?.get(peer) ?? 0) >= seq;

/** A synced event id as the (author, seq) a cursor map covers; a local id is refused — it never travels. */
const targetOf = (event: EventId) => {
  const parsed = parseEventId(String(event));
  if (parsed.isErr()) return panic(`${String(event)}: ${parsed.error.message}`);
  if (parsed.value.local) return panic(`${String(event)}: a local event never leaves this device`);
  return { peer: parsed.value.peerId, seq: parsed.value.seqNum };
};

/**
 * `mesh.received`: a promise that settles once this engine has folded the event — the inbound
 * mirror of `delivered`. What a device awaits after a procedure hands back the event id the
 * authority wrote, so the UI settles on the authority's row rather than a guess.
 */
export function createReceived(engine: Engine): (options: ReceivedOptions) => Promise<void> {
  return ({ event }) => {
    const target = targetOf(event);
    const folded = () => covered(engine.coverage().synced, target.peer, target.seq);
    if (folded()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = engine.onFoldBatch(() => {
        if (!folded()) return;
        off();
        resolve();
      });
    });
  };
}

/**
 * `mesh.delivered`: a promise that settles once a peer's acknowledged cursors cover the target.
 * Delivery, not approval — every receiver runs the same policy itself; an authority's verdict
 * is E12/E16's to add.
 */
export function createDelivered(
  engine: Engine,
  self: PeerId,
): (options?: DeliveredOptions) => Promise<void> {
  const deliveryTarget = (event: EventId | undefined) => {
    if (event !== undefined) return targetOf(event);
    const seq = engine.coverage().synced.get(self);
    return seq === undefined ? undefined : { peer: self, seq };
  };

  return (options = {}) => {
    const target = deliveryTarget(options.event);
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
