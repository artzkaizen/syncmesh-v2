import type { RouteProfile, Transport } from "@syncmesh/transport";

import { KIND } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { runTransports } from "../transports.js";

/** A medium that records what it was asked to carry, and can go offline like a real one. */
const medium = (
  name: string,
  profile?: RouteProfile,
): Transport & {
  readonly presence: Uint8Array[];
  readonly grants: number[];
  readonly goOffline: () => void;
} => {
  const presence: Uint8Array[] = [];
  const grants: number[] = [];
  const listeners = new Set<(online: boolean) => void>();
  const transport: Transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendPresence: (wire) => void presence.push(wire),
    requestGrant: () => void grants.push(1),
    onStatus: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  if (profile !== undefined) Object.assign(transport, { route: () => profile });
  return {
    ...transport,
    presence,
    grants,
    goOffline: () => listeners.forEach((cb) => cb(false)),
  };
};

// SAFETY: the fakes above ignore their context entirely, so nothing here is ever read
const context = {} as Parameters<Transport["start"]>[0];

const RADIO = { direct: true, bandwidthBps: 24_000 } satisfies RouteProfile;
const SLEEPING = { direct: true, bandwidthBps: 24_000, costly: true, dormant: true } as const;

const value = new Uint8Array(100);

describe("what the mesh puts on which link", () => {
  test("presence goes on every link that is up, not on the best one", () => {
    // narrowing to the winner would stop talking to whoever is only reachable on the loser,
    // and nothing here knows which peers a link reaches
    const relay = medium("relay");
    const ble = medium("ble", RADIO);
    const links = runTransports([relay, ble], context);
    links.sendPresence(value);
    expect(relay.presence).toHaveLength(1);
    expect(ble.presence).toHaveLength(1);
  });

  test("a link that has said it is down is not asked to carry anything", () => {
    const relay = medium("relay");
    const ble = medium("ble", RADIO);
    const links = runTransports([relay, ble], context);
    relay.goOffline();
    links.sendPresence(value);
    links.requestGrant();
    expect(relay.presence).toEqual([]);
    expect(relay.grants).toEqual([]);
    expect(ble.presence).toHaveLength(1);
    expect(ble.grants).toHaveLength(1);
  });

  test("a medium that has not spoken yet is assumed up rather than kept idle", () => {
    const quiet = medium("quiet");
    runTransports([quiet], context).sendPresence(value);
    expect(quiet.presence).toHaveLength(1);
  });

  test("presence never wakes a sleeping expensive radio, but the relay still hears it", () => {
    const relay = medium("relay");
    const wifi = medium("wifi-aware", SLEEPING);
    const links = runTransports([relay, wifi], context);
    links.sendPresence(value);
    expect(wifi.presence).toEqual([]);
    expect(relay.presence).toHaveLength(1);
  });

  test("a grant request goes everywhere that is up, because only one link may reach the issuer", () => {
    const relay = medium("relay");
    const wifi = medium("wifi-aware", SLEEPING);
    const links = runTransports([relay, wifi], context);
    links.requestGrant("invite");
    expect(relay.grants).toHaveLength(1);
    // and unlike presence, it is worth the wake: a device with no grant syncs nothing at all
    expect(wifi.grants).toHaveLength(1);
  });
});

describe("the order links come back in", () => {
  test("a page too big for a radio puts the wide link first", () => {
    const relay = medium("relay");
    const ble = medium("ble", RADIO);
    const links = runTransports([ble, relay], context);
    const order = links.route({ cls: KIND.snapshot, bytes: 64 * 1024, redundancy: 2 });
    expect(order.map((t) => t.name)).toEqual(["relay", "ble"]);
  });

  test("a live event two metres away prefers the radio over the round trip to a server", () => {
    const relay = medium("relay");
    const ble = medium("ble", RADIO);
    const links = runTransports([relay, ble], context);
    const order = links.route({ cls: KIND.event, bytes: 200, redundancy: 2 });
    expect(order.map((t) => t.name)).toEqual(["ble", "relay"]);
  });

  test("two mediums configured under one name stay two mediums", () => {
    // the name is the scorer's tie-break, and a tie-break is not an identifier
    const one = medium("relay");
    const two = medium("relay");
    const links = runTransports([one, two], context);
    links.sendPresence(value);
    expect(one.presence).toHaveLength(1);
    expect(two.presence).toHaveLength(1);
  });
});
