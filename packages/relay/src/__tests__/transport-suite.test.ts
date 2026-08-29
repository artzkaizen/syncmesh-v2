import type { Connect } from "@syncmesh/transport/transport-tests";

import { createMemoryEventStore } from "@syncmesh/engine";
import { transportTests } from "@syncmesh/transport/transport-tests";
import { describe, test } from "bun:test";

import type { RelayRoom } from "../room.js";
import type { RelaySocket } from "../sender.js";
import type { RelayDial } from "../transport.js";

import { openRelayRoom } from "../room.js";
import { relayTransport } from "../transport.js";

/**
 * The transport contract, over the relay every deployment actually uses.
 *
 * The suite connects its peers as a chain — each talking only to its neighbours — and a relay
 * room is the opposite shape: everyone in one room, hearing everyone. That is not a reason to
 * skip it. A room is how the relay is deployed, the contract's assertions are about what each
 * peer ends up holding rather than about the path it took, and a room satisfying a chain's
 * expectations is the stronger result.
 */
/**
 * One socket into the room. `losing` is how the suite's chaos knob reaches it: a frame the room
 * hands us is reported as sent and then dropped on the floor — which is exactly a radio, and
 * exactly what the gap rule has to survive. Dropping at the socket rather than in the room keeps
 * the loss one peer's, so the others stay a control group.
 */
const dialInto = (room: RelayRoom, losing?: { count: number }) => (): RelayDial => {
  const frames = new Set<(frame: Uint8Array) => void>();
  const closes = new Set<() => void>();
  let open = true;
  const hangUp = (): void => {
    if (!open) return;
    open = false;
    conn.closed();
    queueMicrotask(() => closes.forEach((cb) => cb()));
  };
  const socket: RelaySocket = {
    send: (frame) => {
      if (!open) return "dropped";
      if (losing !== undefined && losing.count > 0) {
        losing.count -= 1;
        return "sent"; // it left; it simply never arrives, which is the whole point
      }
      const bytes = Uint8Array.from(frame);
      queueMicrotask(() => frames.forEach((cb) => cb(bytes)));
      return "sent";
    },
    close: () => hangUp(),
  };
  const conn = room.connect(socket);
  return {
    send: (frame) => {
      if (!open) throw new Error("relay socket is not open");
      conn.receive(Uint8Array.from(frame));
    },
    onFrame: (cb) => {
      frames.add(cb);
      return () => void frames.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => hangUp(),
  };
};

const connectThroughRelay: Connect = async (peers) => {
  const room = (
    await openRelayRoom({
      name: "suite",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      keepaliveMs: 60_000,
      pageSize: 2, // small on purpose: a multi-page catch-up is where paging bugs live
    })
  ).unwrap();

  // the suite drops on the first link, which here is what reaches the second peer
  const losing = { count: 0 };
  const transports = peers.map((_peer, i) =>
    relayTransport({
      dial: dialInto(room, i === 1 ? losing : undefined),
      reconnectMs: 10,
      name: `relay:${i}`,
    }),
  );
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  return {
    settle: async () => {
      for (let round = 0; round < 8; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const transport of transports) await transport.flush?.();
      }
    },
    stop: async () => {
      await Promise.all(transports.map((transport) => transport.stop()));
      room.close();
    },
    chaos: {
      drop: (count) => void (losing.count = count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
    },
  };
};

describe("the relay runs the transport contract", () => {
  for (const suiteCase of transportTests(connectThroughRelay)) test(suiteCase.name, suiteCase.run);
});
