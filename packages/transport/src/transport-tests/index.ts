export type { OpenChannel } from "./channel.js";
export { channelTests } from "./channel.js";
export type { Connect, Severable, SuiteNetwork, SuitePeer } from "./peers.js";
export { severable, severableStream, suitePeers } from "./peers.js";

import type { Quarantined, SuiteCase } from "@syncmesh/engine";

import { check, equal, spreadable } from "@syncmesh/engine";

import type { Connect, SuiteNetwork, SuitePeer } from "./peers.js";

import {
  NUDGED_ROUNDS,
  RECOVERY_ROUNDS,
  bodyOf,
  settleUntil,
  severance,
  suitePeers,
  write,
} from "./peers.js";

/** Opening a fresh network is every case's first line; naming it keeps each case about its point. */
type Open = () => Promise<{
  readonly peers: readonly [SuitePeer, SuitePeer, SuitePeer];
  readonly network: SuiteNetwork;
}>;

/** What a medium must do when nothing is going wrong: carry, relay, and converge. */
const carries = (openNetwork: Open): readonly SuiteCase[] => [
  {
    name: "transport: three peers in a chain converge, grants first, zero quarantines",
    run: async () => {
      const { peers, network } = await openNetwork();
      const [a, b, c] = peers;
      const quarantined: Quarantined[] = [];
      for (const p of peers) p.engine.onQuarantine((q) => void quarantined.push(q));
      (await write(a, "n1", "from-a")).unwrap();
      (await write(c, "n2", "from-c")).unwrap();
      await network.settle();
      equal(quarantined.length, 0, "quarantines");
      for (const [peer, label] of [
        [a, "a"],
        [b, "b"],
        [c, "c"],
      ] as const) {
        equal(bodyOf(peer, "n1"), "from-a", `n1 at ${label}`);
        equal(bodyOf(peer, "n2"), "from-c", `n2 at ${label}`);
      }
      await network.stop();
    },
  },
  {
    name: "transport: concurrent writes from every peer while apart, none of them lost",
    run: async () => {
      // three peers, each writing a row only it knows about, none able to see the others. The
      // keys differ, so nothing competes and the correct answer is that all three survive —
      // which is only interesting because the middle peer must carry the outer two to each
      // other, and a chain is where a hop that quietly stops forwarding hides
      const { peers, network } = await openNetwork();
      const [a, b, c] = peers;
      (await write(a, "from-a", "a")).unwrap();
      (await write(b, "from-b", "b")).unwrap();
      (await write(c, "from-c", "c")).unwrap();
      await network.settle();
      for (const [peer, label] of [
        [a, "a"],
        [b, "b"],
        [c, "c"],
      ] as const)
        for (const id of ["from-a", "from-b", "from-c"])
          equal(bodyOf(peer, id), id.slice(-1), `${id} at ${label}`);
      await network.stop();
    },
  },
  {
    name: "transport: a peer with nothing of its own to say keeps receiving, round after round",
    run: async () => {
      // the shape that hid a wedged link: `b` writes nothing at all, and must still be carrying
      // `a`'s writes to `c` on the fourth round as faithfully as on the first
      const { peers, network } = await openNetwork();
      const [a, , c] = peers;
      for (const round of [1, 2, 3, 4]) {
        (await write(a, `r${round}`, `round-${round}`)).unwrap();
        await network.settle();
        for (const [peer, label] of [
          [a, "a"],
          [c, "c"],
        ] as const)
          equal(bodyOf(peer, `r${round}`), `round-${round}`, `r${round} at ${label}`);
      }
      await network.stop();
    },
  },
  {
    name: "transport: a write after the sessions are up reaches the far end live",
    run: async () => {
      const { peers, network } = await openNetwork();
      const [a, , c] = peers;
      await network.settle();
      (await write(a, "n3", "late")).unwrap();
      await network.settle();
      equal(bodyOf(c, "n3"), "late", "late write at c");
      await network.stop();
    },
  },
  {
    name: "transport: relayed events carry the author's signature end to end",
    run: async () => {
      const { peers, network } = await openNetwork();
      const [a, b, c] = peers;
      (await write(a, "n1", "signed")).unwrap();
      await network.settle();
      const held = (await c.engine.eventsSince(new Map())).unwrap();
      const fromA = held.find((e) => e.event.peerId === a.identity.peerId);
      check(fromA !== undefined, "c holds a's event");
      check(fromA.sig !== undefined, "with a's original signature, relayed by b");
      check(c.grants.grantFor(a.identity.peerId) !== undefined, "and a's grant");
      equal(bodyOf(b, "n1"), "signed", "b folded it too");
      await network.stop();
    },
  },
];

/**
 * What a medium must do when something is. Each case skips on a medium that cannot be broken on
 * purpose — an absent capability is a fact about the medium, not a failure.
 */
const survivesLoss = (openNetwork: Open): readonly SuiteCase[] => [
  {
    name: "transport: a lost frame is never jumped; resync converges (needs chaos)",
    run: async () => {
      const { peers, network } = await openNetwork();
      if (network.chaos === undefined) {
        await network.stop();
        return;
      }
      const [a, b] = peers;
      await network.settle();
      (await write(a, "n1", "one")).unwrap();
      await network.settle();
      network.chaos.drop(1);
      (await write(a, "n2", "two")).unwrap();
      (await write(a, "n3", "three")).unwrap();
      await network.settle();
      check(bodyOf(b, "n3") === undefined, "n3 held out behind the lost n2");
      network.chaos.resyncAll();
      await network.settle();
      equal(bodyOf(b, "n2"), "two", "n2 after resync");
      equal(bodyOf(b, "n3"), "three", "n3 after resync");
      await network.stop();
    },
  },
  {
    name: "transport: a write made while the medium was severed arrives once it is back (needs severance)",
    run: async () => {
      // the Wi-Fi off → on incident, as a case. Nothing here restarts a transport, resyncs one
      // or nudges one: the medium goes, a write is made into the dark, the medium comes back,
      // and the only question is whether the transport ever notices on its own
      const { peers, network } = await openNetwork();
      const chaos = severance(network);
      if (chaos === undefined) {
        // settled before stopped, even here: a network this case only just opened still has a
        // handshake in flight, and pulling the medium out from under one is a teardown race
        // rather than a skip
        await network.settle();
        await network.stop();
        return;
      }
      const [a, b] = peers;
      await network.settle();
      (await write(a, "before", "before")).unwrap();
      await network.settle();
      equal(bodyOf(b, "before"), "before", "the link carried before the severance");

      chaos.sever();
      (await write(a, "during", "written into the dark")).unwrap();
      await network.settle();
      check(bodyOf(b, "during") === undefined, "nothing crossed while the medium was gone");

      chaos.restore();
      check(
        await settleUntil(network, RECOVERY_ROUNDS, () => bodyOf(b, "during") !== undefined),
        "the write never arrived after the medium came back: this transport is still holding a link that died without saying so, and needs a nudge nothing is giving it",
      );
      equal(bodyOf(b, "during"), "written into the dark", "the severed write at b");
      await network.stop();
    },
  },
  {
    name: "transport: wake() converges a severed medium without waiting out a deadline (needs severance and wake)",
    run: async () => {
      // the ~37-second window, as a case. A liveness deadline is 2.5× a keepalive and a person
      // is faster than that, so `wake` is what a platform which already knows — a reachability
      // callback, an app returning to the foreground — says instead of nothing
      const { peers, network } = await openNetwork();
      const chaos = severance(network);
      if (chaos === undefined || network.wake === undefined) {
        await network.settle();
        await network.stop();
        return;
      }
      const [a, b] = peers;
      await network.settle();
      chaos.sever();
      (await write(a, "nudged", "waiting on a nudge")).unwrap();
      await network.settle();
      chaos.restore();
      network.wake();
      check(
        await settleUntil(network, NUDGED_ROUNDS, () => bodyOf(b, "nudged") !== undefined),
        "wake() did not converge the link promptly: whatever re-established it was a timeout, and the seconds before that timeout are the ones the user spends looking at a stale screen",
      );
      equal(bodyOf(b, "nudged"), "waiting on a nudge", "the severed write after the nudge");
      await network.stop();
    },
  },
  {
    name: "transport: a severance loses nothing and duplicates nothing (needs severance)",
    run: async () => {
      // the other half of the contract: the case above asks whether it comes back, this asks
      // what it comes back *to*. A medium that failed silently and a recovery that re-requests
      // from a cursor are between them every condition for folding an event twice or skipping
      // one — and both ends wrote while neither could hear the other, so there is something to
      // get wrong. `resyncAll` rather than nothing, deliberately: whether it converges by
      // itself is the question above, and asking it twice would only hide this one
      const { peers, network } = await openNetwork();
      const chaos = severance(network);
      if (chaos === undefined) {
        // settled before stopped, even here: a network this case only just opened still has a
        // handshake in flight, and pulling the medium out from under one is a teardown race
        // rather than a skip
        await network.settle();
        await network.stop();
        return;
      }
      const [a, b, c] = peers;
      const quarantined: Quarantined[] = [];
      for (const p of peers) p.engine.onQuarantine((q) => void quarantined.push(q));
      await network.settle();

      chaos.sever();
      (await write(a, "split-a", "a")).unwrap();
      (await write(c, "split-c", "c")).unwrap();
      await network.settle();
      chaos.restore();
      chaos.resyncAll();
      check(
        await settleUntil(network, RECOVERY_ROUNDS, () =>
          peers.every(
            (peer) =>
              bodyOf(peer, "split-a") !== undefined && bodyOf(peer, "split-c") !== undefined,
          ),
        ),
        "a write made during the severance is still missing somewhere after the repair",
      );

      equal(quarantined.length, 0, "quarantines");
      for (const [peer, label] of [
        [a, "a"],
        [b, "b"],
        [c, "c"],
      ] as const) {
        equal(bodyOf(peer, "split-a"), "a", `split-a at ${label}`);
        equal(bodyOf(peer, "split-c"), "c", `split-c at ${label}`);
        const held = (await peer.engine.eventsSince(new Map())).unwrap();
        const ids = held.map((stored) => stored.event.id);
        equal(new Set(ids).size, ids.length, `${label} holds each event once`);
      }
      await network.stop();
    },
  },
];

/** What a transport must be for a wrapper to build on it, before any of it runs (D29). */
const wrappable = (openNetwork: Open): readonly SuiteCase[] => [
  {
    name: "transport: every member is an own property, so a wrapper that spreads it keeps them all",
    run: async () => {
      const { network } = await openNetwork();
      await network.settle();
      for (const transport of network.transports) spreadable(transport, transport.name);
      await network.stop();
    },
  },
];

/**
 * The contract every transport must satisfy, over a three-peer chain, for any test runner.
 *
 * @example
 * for (const c of transportTests(connectOverLoopback)) test(c.name, c.run);
 */
export function transportTests(connect: Connect): readonly SuiteCase[] {
  const openNetwork: Open = async () => {
    const peers = suitePeers();
    const network = await connect(peers);
    return { peers, network };
  };

  return [...wrappable(openNetwork), ...carries(openNetwork), ...survivesLoss(openNetwork)];
}
