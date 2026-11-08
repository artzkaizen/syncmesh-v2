import type { Cursors, StoredEvent } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import { eventFrame } from "@syncmesh/transport";
import { relayEnvelope, signEvent } from "@syncmesh/wire";

/** A stored event as bytes to send: this device signs its own, and relays another's verbatim. */
const outgoingEnvelope = (entry: StoredEvent, ctx: TransportContext): Uint8Array | undefined =>
  entry.event.peerId === ctx.identity.peerId
    ? signEvent(entry.event, ctx.identity).wire
    : relayEnvelope(entry);

/**
 * Everything this device holds above `relayCursors`, whoever wrote it, sent to the room — and the
 * cursors moved past what was sent, so the next call sends the difference rather than the run.
 *
 * Not only what this device authored: a peer with a radio and a network is the only way an event
 * written where there is no network ever reaches one, and forwarding is the whole of carrying it.
 * A log that cannot be read sends nothing and leaves the cursors where they were.
 */
export async function sendOutstanding(
  context: TransportContext,
  relayCursors: Cursors,
  send: (frame: Uint8Array) => void,
): Promise<Cursors> {
  const entries = await context.engine.eventsSince(relayCursors);
  if (entries.isErr()) return relayCursors;
  const sent = new Map(relayCursors);
  for (const entry of entries.value) {
    const wire = outgoingEnvelope(entry, context);
    if (wire === undefined) continue;
    send(eventFrame(wire));
    const at = sent.get(entry.event.peerId);
    if (at === undefined || entry.event.seqNum > at)
      sent.set(entry.event.peerId, entry.event.seqNum);
  }
  return sent;
}
