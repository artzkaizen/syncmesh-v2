import type { Unsubscribe } from "@syncmesh/engine";

/**
 * Best-effort pub/sub between relay instances serving the same room (D09-B). Never
 * load-bearing: a frame it loses is recovered by the next cursor catch-up. A link never
 * hears its own publishes — the publisher already delivered to its own sockets.
 */
export interface Fanout {
  readonly connect: (room: string) => FanoutLink;
}

export interface FanoutLink {
  readonly publish: (frame: Uint8Array) => void;
  readonly onFrame: (cb: (frame: Uint8Array) => void) => Unsubscribe;
  readonly close: () => void;
}

interface Member {
  readonly listeners: Set<(frame: Uint8Array) => void>;
}

/** In-process fanout: what tests use, and what a single-box relay does not need at all. */
export function memoryFanout(): Fanout {
  const rooms = new Map<string, Set<Member>>();
  return {
    connect: (room) => {
      const members = rooms.get(room) ?? new Set<Member>();
      rooms.set(room, members);
      const me: Member = { listeners: new Set() };
      members.add(me);
      return {
        publish: (frame) => {
          for (const member of members) {
            if (member === me) continue;
            for (const cb of member.listeners) cb(frame);
          }
        },
        onFrame: (cb) => {
          me.listeners.add(cb);
          return () => void me.listeners.delete(cb);
        },
        close: () => void members.delete(me),
      };
    },
  };
}
