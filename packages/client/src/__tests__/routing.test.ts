import type { PeerId } from "@syncmesh/kernel";
import type { RouteMessage, RouteProfile, Transport, TransportContext } from "@syncmesh/transport";

import { KIND, ORDINARY_LINK } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { runTransports } from "../transports.js";

/** A fixture peer id: 64 hex characters, which is the whole of the brand's invariant. */
const peer = (digit: string) => {
  // SAFETY: 64 lowercase hex characters, exactly what `parsePeerId` checks for
  const id = digit.repeat(64) as PeerId;
  return id;
};
const alice = peer("a");
const bob = peer("b");

/** Declares what it is, remembers the context it was started with, and does nothing else. */
const stub = (name: string, profile: RouteProfile, reaches: ReadonlySet<PeerId>) => {
  let started: TransportContext | undefined;
  const transport: Transport = {
    name,
    start: (ctx) => {
      started = ctx;
      return Promise.resolve();
    },
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    route: () => profile,
    reaches: () => reaches,
  };
  const carries = (message: RouteMessage) => started?.carries?.(name, message);
  return { transport, carries };
};

/** The context a mesh hands a transport. */
// SAFETY: only `carries` is read here — `runTransports` adds it, and these stubs open no session, so the engine and identity a real bridge would need are never reached
const context = {} as TransportContext;

const run = async (...made: readonly ReturnType<typeof stub>[]) => {
  const links = runTransports(
    made.map((m) => m.transport),
    context,
  );
  await links.ready();
  return links;
};

/** BLE's numbers, written out rather than imported: the client does not depend on a radio. */
const radio = { direct: true, bandwidthBps: 24_000 } satisfies RouteProfile;

describe("which link carries an event (E28)", () => {
  test("a small event to a peer on both takes the direct radio, not the relay", async () => {
    const ble = stub("ble", radio, new Set([alice]));
    const relay = stub("relay", ORDINARY_LINK, new Set([alice]));
    const links = await run(ble, relay);

    const small = { cls: KIND.event, bytes: 200, to: alice } satisfies RouteMessage;
    expect(ble.carries(small)).toBe(true);
    expect(relay.carries(small)).toBe(false);

    await links.stop();
  });

  test("a snapshot page to the same peer takes the wide link instead", async () => {
    const ble = stub("ble", radio, new Set([alice]));
    const relay = stub("relay", ORDINARY_LINK, new Set([alice]));
    const links = await run(ble, relay);

    const page = { cls: KIND.snapshot, bytes: 2_000_000, to: alice } satisfies RouteMessage;
    expect(relay.carries(page)).toBe(true);
    expect(ble.carries(page)).toBe(false);

    await links.stop();
  });

  test("a peer only one link reaches goes down that link, whatever it scores", async () => {
    const ble = stub("ble", radio, new Set([alice]));
    const relay = stub("relay", ORDINARY_LINK, new Set([bob]));
    const links = await run(ble, relay);

    const toBob = { cls: KIND.event, bytes: 200, to: bob } satisfies RouteMessage;
    // the radio would win on score; it does not reach bob, so it is not asked
    expect(relay.carries(toBob)).toBe(true);
    expect(ble.carries(toBob)).toBe(false);

    await links.stop();
  });

  test("a lone transport carries everything, however badly it scores", async () => {
    const ble = stub("ble", radio, new Set([alice]));
    const links = await run(ble);

    const page = { cls: KIND.snapshot, bytes: 20_000_000, to: alice } satisfies RouteMessage;
    expect(ble.carries(page)).toBe(true);

    await links.stop();
  });

  test("a peer nobody claims still reaches a link — narrowing never drops a frame", async () => {
    const carol = peer("c");
    const ble = stub("ble", radio, new Set([alice]));
    const relay = stub("relay", ORDINARY_LINK, new Set([alice]));
    const links = await run(ble, relay);

    const toCarol = { cls: KIND.event, bytes: 200, to: carol } satisfies RouteMessage;
    const reached = [ble.carries(toCarol), relay.carries(toCarol)].filter(Boolean);
    expect(reached.length).toBeGreaterThan(0);

    await links.stop();
  });
});
