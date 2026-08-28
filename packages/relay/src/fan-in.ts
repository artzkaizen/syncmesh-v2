import type { RoomState } from "./state.js";

import { decodeRelayFrame } from "./frames.js";
import { absorbEvent } from "./ingest.js";

/**
 * A frame from another instance serving the same room (D09-B).
 *
 * It is **ingested**, not merely forwarded — API.md §13.5's word, and the difference between two
 * instances of one room and two rooms with the same name. Forwarding alone left the receiving
 * instance's log empty: a phone that joined it afterwards caught up to a shorter room, the grants
 * that arrived by fan-out never reached the cache a joiner is paged from, and a client that had
 * narrowed its interest was sent whatever the other instance happened to relay, because a forward
 * goes to every socket and an ingest goes to the ones that asked.
 *
 * Nothing is published from here. The frame already reached every other instance from the one
 * that first sent it, so re-publishing would multiply one write by the size of the fleet.
 *
 * Best-effort stays best-effort: a frame the transport drops is not recovered by this. What
 * recovers it is a device that holds the event joining this instance and pushing everything above
 * the cursors the `hello` advertised — which is only possible because the log here is now the set
 * of events this instance actually heard, rather than nothing at all.
 */
export function fanIn(room: RoomState): (frame: Uint8Array) => void {
  return (frame) => {
    const decoded = decodeRelayFrame(frame);
    if (decoded.isErr()) return; // junk between instances is dropped, never passed on
    const value = decoded.value;
    if (value.kind === "relayed") {
      // on the room's own queue, so the offset it lands on is the one its clients are told
      room.enqueue(async () => {
        const absorbed = await absorbEvent(room, value.wire);
        // there is no socket to refuse and nothing to ack: junk or a failed write stops here, and
        // the instance that sent it still holds the event for whoever asks it next
        if (absorbed.isErr()) return;
      });
      return;
    }
    if (value.kind !== "session") return; // a control frame belongs to one socket, not to a room
    const inner = value.frame;
    if (inner.kind === "grant") {
      // the cache a joiner's first page is built from, on this instance as much as on that one
      if (room.grants.admit(inner.wire)) room.toClients(frame);
      return;
    }
    // presence and the peer-to-peer facts pass through byte-identical, as they do from a socket
    room.toClients(frame);
  };
}
