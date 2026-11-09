import { Temporal, durationMs } from "@syncmesh/temporal";
import { presenceFrame, presenceSlot } from "@syncmesh/transport";

import type { RelayDial } from "./transport.js";

/** How often a held value asks the socket again whether its buffer has emptied. */
export const PRESENCE_RECHECK = Temporal.Duration.from({ milliseconds: 50 });

/** A device's own presence on its way to a relay, held per slot while the socket is behind. */
export interface PresenceHold {
  /** Sends the value now, or holds it in its slot's place while the socket's buffer is not empty. */
  readonly offer: (wire: Uint8Array) => void;
  /** Slots holding a value that has not left yet. */
  readonly size: () => number;
}

/**
 * The device's half of D16 on a relay link: a WebSocket has no `sendLatest`, and every value
 * handed to a socket whose buffer is not empty waits behind the ones before it. So while the
 * socket's `buffered` says it still holds unsent bytes, a value is held in its `(topic, instance,
 * peer)` slot in place of the one before it, and the newest per slot leaves as a presence frame
 * once the buffer is empty — rechecked every {@link PRESENCE_RECHECK}, since a browser WebSocket
 * fires no drain event. A browser's `bufferedAmount` is often above zero for a moment after any
 * send, so a value offered just after an event write can wait up to one recheck on a healthy link.
 *
 * What is held is for the socket it was held on: once `socket` answers another one, or none,
 * every held value is dropped — a fresh socket is announced to afresh. A dial that cannot say how
 * much it holds sends everything at once, as before. Bytes that are not a presence value are
 * never held.
 */
export function createPresenceHold(
  send: (frame: Uint8Array) => void,
  socket: () => Pick<RelayDial, "buffered"> | undefined,
  recheck = PRESENCE_RECHECK,
): PresenceHold {
  const held = new Map<string, Uint8Array>();
  let heldOn: Pick<RelayDial, "buffered"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const behind = (): boolean => (socket()?.buffered?.() ?? 0) > 0;

  const flush = (): void => {
    timer = undefined;
    if (socket() !== heldOn || heldOn === undefined) {
      held.clear();
      return;
    }
    for (const [slot, wire] of held) {
      if (behind()) {
        arm();
        return;
      }
      held.delete(slot);
      send(presenceFrame(wire));
    }
  };
  const arm = (): void => {
    timer ??= setTimeout(flush, durationMs(recheck));
  };

  return {
    offer: (wire) => {
      const slot = presenceSlot(wire);
      if (slot === undefined || (held.size === 0 && !behind())) {
        send(presenceFrame(wire));
        return;
      }
      if (socket() !== heldOn) held.clear();
      heldOn = socket();
      // a slot already held keeps its place in line: a newer value takes the older one's
      held.set(slot, wire);
      arm();
    },
    size: () => held.size,
  };
}
