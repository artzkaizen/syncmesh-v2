import type { Cursors } from "@syncmesh/engine";

import { grantFrame, presenceSlot } from "@syncmesh/transport";
import { decodeAndVerifyPresence, relayEnvelope } from "@syncmesh/wire";

import type { RoomState } from "./state.js";

import { routeCustody } from "./custody-route.js";
import { decodeRelayFrame } from "./frame-decode.js";
import { helloFrame, relayedFrame } from "./frames.js";
import { absorbEvent } from "./ingest.js";
import { admitGrant } from "./trust.js";

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
 * Nothing heard is published again. The frame already reached every other instance from the one
 * that first sent it, so re-publishing would multiply one write by the size of the fleet. The one
 * thing published from here is an answer: another instance's `hello`, sent when it opens the room,
 * is answered with what this log holds above it (gaps U41).
 *
 * Best-effort stays best-effort: a frame the transport drops while both instances hold the room
 * is not recovered by this. What recovers it is a device that holds the event joining this
 * instance and pushing everything above the cursors the `hello` advertised — or this instance
 * opening the room afresh, after an idle eviction, and greeting the fleet again
 * ({@link fleetGreeting}, cut to what the transport carries).
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
    // another instance has just opened this room and says where its log stands (gaps U41)
    if (value.kind === "hello") {
      room.enqueue(() => catchUpInstance(room, value.cursors));
      return;
    }
    // a receipt or a refusal is for its author alone, here as from a socket (D32)
    if (value.kind === "refusal") {
      routeCustody(room, frame, value, "fleet");
      return;
    }
    if (value.kind !== "session") return; // a control frame belongs to one socket, not to a room
    const inner = value.frame;
    if (inner.kind === "grant") {
      // the cache a joiner's first page is built from, on this instance as much as on that one
      if (admitGrant(room, inner.wire)) room.toClients(frame);
      return;
    }
    if (inner.kind === "receipt") {
      routeCustody(room, frame, inner, "fleet");
      return;
    }
    if (inner.kind === "presence") {
      // admitted here as from a socket: a stale value (an author who moved instances) must not
      // take the place of the newer one a stalled reader is holding, and a joiner here is greeted
      // with who is on the other instances too
      const verified = decodeAndVerifyPresence(inner.wire);
      if (verified.isErr() || !room.presence.admit(verified.value)) return;
      room.toClientsLatest(presenceSlot(inner.wire), frame);
      return;
    }
    // the peer-to-peer facts pass through byte-identical, as they do from a socket
    room.toClients(frame);
  };
}

/**
 * What another instance missed before it opened this room, sent back over the fan-out: every
 * grant this room holds, then every event above the cursors its greeting named (gaps U41).
 *
 * The cursor exchange a device runs on every join, run between instances. An instance hears a
 * room only from the moment it opens it, so what was fanned out before then reached it as
 * nothing; this re-pages it from the instances that were listening. Grants go first, so the
 * events they vouch for land after them on the opening instance's sockets.
 *
 * Every instance holding the room answers and every one hears the answers, so the opening
 * instance takes each event once per answering instance and the rest take events they already
 * hold: a `has` each, deduplicated by id, which is the price of a port with no addressing.
 * Published straight from the log, one frame per event, on the room's queue — so a room with a
 * long history spends its fan-out rate on it, and an event too large for the transport goes as
 * the transport's own gap signal, exactly as it does live. Unpaced and outside the room's
 * `roomFanout` budget: a greeting with few cursors on a long log is answered with all of it, by
 * every instance holding the room.
 *
 * The answer is this log as it stands, floor and all: an answerer trimmed above the opener's
 * cursors sends what it still holds, and the hole below it waits for a device join to fill.
 */
async function catchUpInstance(room: RoomState, theirs: Cursors): Promise<void> {
  const entries = await room.store.allSince(theirs);
  // nothing to send it from: the opening instance still has whatever devices push on their joins
  if (entries.isErr()) return;
  for (const wire of room.grants.all()) room.publish(grantFrame(wire));
  for (const entry of entries.value) {
    const wire = relayEnvelope(entry);
    if (wire !== undefined) room.publish(relayedFrame(wire, room.offset()));
  }
}

/** What {@link fleetGreeting} is built from. */
export interface FleetGreeting {
  /** The highest protocol version the room speaks. */
  readonly version: number;
  readonly keepaliveMs: number;
  readonly epoch: string;
  /** Where the opening room's log stands. */
  readonly cursors: Cursors;
  /** The largest frame the fan-out carries as itself (`FanoutLink.maxFrame`); absent, no limit. */
  readonly maxFrame?: number | undefined;
}

/**
 * The `hello` a room opening on an instance publishes on the fan-out, for every instance already
 * holding the room to answer (gaps U41).
 *
 * Its cursors and no floor, since {@link fanIn} reads only the cursors. Past `maxFrame` it names
 * the authors furthest along and leaves the rest out: an author left out is answered from its
 * first event, which costs the opener duplicates it drops by id and never a gap. A frame the
 * fan-out could not carry would be no greeting at all.
 *
 * @example
 * ```ts
 * fan.publish(fleetGreeting({ version: 4, keepaliveMs: 15_000, epoch, cursors, maxFrame: fan.maxFrame }));
 * ```
 */
export function fleetGreeting(greeting: FleetGreeting): Uint8Array {
  const { version, keepaliveMs, epoch, cursors, maxFrame } = greeting;
  const hello = (named: Cursors) => helloFrame(version, keepaliveMs, epoch, named);
  const whole = hello(cursors);
  if (maxFrame === undefined || whole.length <= maxFrame) return whole;
  const furthest = [...cursors].sort(([, a], [, b]) => b - a);
  // the longest prefix that fits: every entry costs about the same, so a bisection over it
  let fits = 0;
  let over = furthest.length;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (hello(new Map(furthest.slice(0, mid))).length <= maxFrame) fits = mid;
    else over = mid;
  }
  return hello(new Map(furthest.slice(0, fits)));
}
