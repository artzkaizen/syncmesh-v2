import type { Connect, Severable } from "@syncmesh/transport/transport-tests";

import { createMemoryEventStore } from "@syncmesh/engine";
import { severable, transportTests } from "@syncmesh/transport/transport-tests";
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
 *
 * `network` is the device's route to the relay, and how the suite's severance reaches it: severed,
 * this socket is orphaned rather than closed — the room writes to it, the client writes to it,
 * and neither call fails or is told anything, which is a Wi-Fi switch thrown with a socket open.
 */
const dialInto =
  (room: RelayRoom, network: Severable, losing?: { count: number }) => (): RelayDial => {
    if (!network.carrying()) throw new Error("no route to the relay: the network is down");
    const frames = new Set<(frame: Uint8Array) => void>();
    const closes = new Set<() => void>();
    /** What the room sent before the transport subscribed — its challenge (D33) — kept as a socket would. */
    const early: Uint8Array[] = [];
    /** This socket's own liveness. False for ever once a severance has passed under it. */
    const carrying = network.linked();
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
        // the room is holding a socket whose network went away: the write it makes is accepted by
        // the kernel and carried nowhere, and nothing in this process is in a position to know
        if (!carrying()) return "sent";
        if (losing !== undefined && losing.count > 0) {
          losing.count -= 1;
          return "sent"; // it left; it simply never arrives, which is the whole point
        }
        const bytes = Uint8Array.from(frame);
        queueMicrotask(() => {
          if (frames.size === 0) early.push(bytes);
          else frames.forEach((cb) => cb(bytes));
        });
        return "sent";
      },
      close: () => hangUp(),
    };
    const conn = room.connect(socket);
    return {
      send: (frame) => {
        if (!open) throw new Error("relay socket is not open");
        /**
         * **No throw, and that is the defect being modelled.** RFC-0005 has `send` fail loudly
         * when a frame did not leave, and this socket obeys it everywhere it can tell — but an
         * orphaned TCP connection cannot tell. The bytes enter a send buffer belonging to an
         * interface that is gone, the call returns, and the transport above records a frame it
         * believes is on its way to the room.
         */
        if (!carrying()) return;
        conn.receive(Uint8Array.from(frame));
      },
      onFrame: (cb) => {
        frames.add(cb);
        for (const bytes of early.splice(0)) cb(bytes);
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
  const network = severable();
  const room = (
    await openRelayRoom({
      name: "suite",
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      /**
       * Small, because the contract's severance case waits this deadline out.
       *
       * A client hangs up at 2.5× whatever the room announces, and that is the only thing which
       * ever notices a socket the network abandoned. Production announces 15s, so the wait there
       * is the ~37 seconds the incident was about; announcing 150ms here runs the same code path
       * in under half a second. It is also far longer than a settle round, so nothing else in the suite
       * goes quiet long enough to trip it.
       */
      keepaliveMs: 150,
      pageSize: 2, // small on purpose: a multi-page catch-up is where paging bugs live
    })
  ).unwrap();

  // the suite drops on the first link, which here is what reaches the second peer
  const losing = { count: 0 };
  const transports = peers.map((_peer, i) =>
    relayTransport({
      dial: dialInto(room, network, i === 1 ? losing : undefined),
      reconnectMs: 10,
      name: `relay:${i}`,
    }),
  );
  await Promise.all(transports.map((transport, i) => transport.start(peers[i]!)));

  return {
    transports,
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
    wake: () => transports.forEach((transport) => transport.wake?.()),
    chaos: {
      drop: (count) => void (losing.count = count),
      resyncAll: () => transports.forEach((transport) => transport.resync?.()),
      /**
       * Every socket into the room is orphaned where it stands, and no new one can be dialled.
       *
       * Nothing is closed and nobody is told — the room goes on writing to sockets it believes
       * are connected, and each client goes on holding one it believes is live. This is the
       * fake's whole reason for existing: a `close()` here would be a fake that never reproduced
       * the incident it was written for.
       */
      sever: network.sever,
      /** The network is back, so a *fresh* dial lands. The sockets it abandoned stay abandoned. */
      restore: network.restore,
    },
  };
};

describe("the relay runs the transport contract", () => {
  for (const suiteCase of transportTests(connectThroughRelay)) test(suiteCase.name, suiteCase.run);
});
