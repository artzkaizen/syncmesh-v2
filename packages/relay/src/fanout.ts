import type { Unsubscribe } from "@syncmesh/engine";

/**
 * Best-effort pub/sub between relay instances serving the same room (D09-B). A link never hears
 * its own publishes — the publisher already delivered to its own sockets.
 *
 * **Best-effort is not free.** A receiving instance ingests what it hears (`fanIn`), so its log is
 * the set of frames that reached it — and a frame this transport drops is not in that set and is
 * not re-requested while both instances hold the room. What puts it back is a cursor exchange: a
 * device that holds the event joining this instance pushes everything above the cursors its
 * `hello` advertised, and an instance opening the room greets the fleet with its own cursors and
 * is answered with what lies above them (gaps U41). Until one of those happens, this instance
 * cannot serve that event to anyone, and two phones pinned to two instances do not converge. A fleet whose sockets are sticky and whose devices are
 * few should treat a dropped frame as a real outage, not as a rounding error.
 */
export interface Fanout {
  readonly connect: (room: string) => FanoutLink;
}

export interface FanoutLink {
  readonly publish: (frame: Uint8Array) => void;
  readonly onFrame: (cb: (frame: Uint8Array) => void) => Unsubscribe;
  /**
   * Settles once this link hears the room — a subscription acknowledged — after its first
   * `onFrame`. A frame another instance publishes before then never reaches this one, so a room
   * waits for it before it seats a socket (gaps U41). Absent: hearing starts at once.
   */
  readonly heard?: () => Promise<void>;
  /**
   * The largest frame this link carries as itself, in bytes; a larger one is not delivered (the
   * Postgres link sends a wake in its place). A room cuts its fleet greeting to fit it (gaps U41).
   * Absent: no limit.
   */
  readonly maxFrame?: number;
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
