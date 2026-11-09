import type { PeerId, SyncEvent } from "@syncmesh/kernel";
import type { RelaySocket } from "@syncmesh/relay";

import { createMemoryEventStore } from "@syncmesh/engine";
import { parsePeerId } from "@syncmesh/kernel";
import { decodeRelayFrame, joinFrame, openRelayRoom } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { eventFrame } from "@syncmesh/transport";
import { createIdentity, signEvent } from "@syncmesh/wire";

/**
 * A relay room with `subscribers` sockets joined to it and one author connected, for timing what
 * one event costs the room from the author's frame to the last subscriber's send.
 *
 * The room speaks protocol 1 beside 2 so a bare `joinFrame` seats a socket without a handshake —
 * what the relay's own suite does to reach a room's behaviour after the join, and what keeps the
 * fixture about the fan-out. The sockets are in-process and always `sent`: the cost measured is
 * the room's (ingest, the log append, the per-subscriber interest check and enqueue), never a
 * network's.
 *
 * Every event is signed before the clock starts, because the room verifies each one and a pool
 * is the only way to keep the signing out of the measurement; `pool` must outnumber the calls.
 */
export async function fanoutRoom(
  subscribers: number,
  event: (author: PeerId, seq: number) => SyncEvent,
  pool: number,
) {
  const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 150 + i)).unwrap();
  const room = (
    await openRelayRoom({
      name: "bench",
      store: createMemoryEventStore(),
      epoch: "bench",
      keepaliveMs: 3_600_000,
      versions: [1, 2],
      pageSize: 2_000,
      maxBacklog: 1_000_000,
    })
  ).unwrap();

  // the last subscriber seated is the last one the room's loop sends to: its relayed frame is
  // the moment every subscriber has been sent the event
  let arrived = (): void => undefined;
  const quiet: RelaySocket = { send: () => "sent", close: () => undefined };
  const last: RelaySocket = {
    send: (frame) => {
      const decoded = decodeRelayFrame(frame);
      if (decoded.isOk() && decoded.value.kind === "relayed") arrived();
      return "sent";
    },
    close: () => undefined,
  };
  for (let i = 0; i < subscribers; i += 1) {
    const socket = i === subscribers - 1 ? last : quiet;
    room.connect(socket).receive(joinFrame([1], subscriber(i), new Map()));
  }
  const from = room.connect(quiet);
  from.receive(joinFrame([1], author.peerId, new Map()));
  while (room.clients() < subscribers + 1) await Bun.sleep(1);

  const frames = Array.from({ length: pool }, (_, i) =>
    eventFrame(signEvent(event(author.peerId, i + 1), author).wire),
  );
  let next = 0;
  return {
    /** Hands the room the next signed event, and settles once the last subscriber was sent it. */
    publish: () => {
      const frame = frames[next] ?? panic(`the fan-out pool of ${pool} events ran out`);
      next += 1;
      const sent = new Promise<void>((resolve) => (arrived = resolve));
      from.receive(frame);
      return sent;
    },
    close: () => room.close(),
  };
}

/** A distinct peer id per subscriber: the room keys its clients by who they say they are. */
const subscriber = (i: number): PeerId => parsePeerId(i.toString(16).padStart(64, "0")).unwrap();
