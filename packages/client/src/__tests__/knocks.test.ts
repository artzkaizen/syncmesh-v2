import type { Transport, TransportContext } from "@syncmesh/transport";

import { PEER_A } from "@syncmesh/kernel/test-fixtures";
import { describe, expect, test } from "bun:test";

import type { Knock } from "../transports.js";

import { runTransports } from "../transports.js";

/**
 * The context a mesh hands a transport.
 *
 * Only this device's own peer id is here, and only because `add` runs a budget sweep on the way
 * past: none of the stubs below can name a link or close one, so the sweep reads the id and stops.
 * Nothing here opens a session or routes a frame, so the engine and the grant registry a real
 * bridge would read are never reached.
 */
// SAFETY: a `TransportContext` carries this member with this type; the rest is unreached, as above
const context = { identity: { peerId: PEER_A } } as TransportContext;

/**
 * A medium that records being woken and does nothing else.
 *
 * `hasDoor` is the whole of what distinguishes the two kinds of transport this seam has to handle:
 * one that can re-establish its own link and one that cannot say anything about it. The second is
 * not a degenerate case to be tolerated — it is what the loopback and in-memory transports every
 * other test in this package uses actually are.
 */
const medium = (name: string, hasDoor = true) => {
  let woken = 0;
  const transport: Transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    ...(hasDoor && { wake: () => void (woken += 1) }),
  };
  return { transport, woken: () => woken };
};

/**
 * A platform that can be made to say the world moved, on demand.
 *
 * It also answers whether anything is still listening, which is the half of the contract that has
 * no other witness: an unsubscribe that is never called leaves a listener holding every transport
 * it captured, and the only place that shows up otherwise is a phone that grows slower over a
 * session and is fine again after a cold start.
 */
const platform = () => {
  const listening = new Set<() => void>();
  const knock: Knock = (wake) => {
    listening.add(wake);
    return () => void listening.delete(wake);
  };
  return {
    knock,
    signal: () => {
      for (const wake of listening) wake();
    },
    listening: () => listening.size,
  };
};

describe("a knock on every medium's door", () => {
  test("one signal wakes every transport that has a door, and skips the ones that do not", () => {
    const relay = medium("relay");
    const radio = medium("ble");
    const deaf = medium("loopback", false);
    const world = platform();
    runTransports([relay.transport, radio.transport, deaf.transport], context, {}, [world.knock]);

    world.signal();

    expect(relay.woken()).toBe(1);
    expect(radio.woken()).toBe(1);
    expect(deaf.woken()).toBe(0);
  });

  test("a medium added after the mesh opened is woken too", async () => {
    const relay = medium("relay");
    const world = platform();
    const links = runTransports([relay.transport], context, {}, [world.knock]);

    const radio = medium("ble");
    (await links.add(radio.transport)).unwrap();
    world.signal();

    expect(radio.woken()).toBe(1);
    expect(relay.woken()).toBe(1);
  });

  test("every knock is answered, not just the first", () => {
    const relay = medium("relay");
    const foreground = platform();
    const network = platform();
    runTransports([relay.transport], context, {}, [foreground.knock, network.knock]);

    foreground.signal();
    network.signal();

    expect(relay.woken()).toBe(2);
  });

  test("stopping lets the platform go, and a late signal wakes nothing", async () => {
    const relay = medium("relay");
    const world = platform();
    const links = runTransports([relay.transport], context, {}, [world.knock]);
    expect(world.listening()).toBe(1);

    await links.stop();
    expect(world.listening()).toBe(0);

    // the source itself, called anyway: a platform that has not noticed the unsubscribe yet is the
    // gap this is guarded for, and a redial there reopens a socket the mesh has finished with
    world.signal();
    expect(relay.woken()).toBe(0);
  });

  test("an app that names no knocks is the mesh exactly as it was", async () => {
    const relay = medium("relay");
    const links = runTransports([relay.transport], context);

    await links.ready();
    await links.stop();

    expect(relay.woken()).toBe(0);
  });
});
