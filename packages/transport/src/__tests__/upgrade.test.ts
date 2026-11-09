import type { PeerId } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { Bridge } from "../bridge.js";

import { createAdmissionGate } from "../gate.js";
import { loopbackPair } from "../link.js";
import { createUpgrader } from "../upgrade.js";
import { T0 } from "./fixtures.js";

const ISSUER = createIdentity(seed(30)).unwrap();
const STRANGER = createIdentity(seed(31)).unwrap();
const ACME = parsePartitionKey("org:acme").unwrap();

/** A grant for `device` in ACME, signed by `by`. */
const grantOf = (device: PeerId, by = ISSUER) =>
  issueGrant(by, {
    account: `acct_${device.slice(0, 4)}`,
    device,
    role: "member",
    partitions: [ACME],
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0,
  });

/**
 * One device: its identity, the grants it knows, and a door that admits only peers whose grant
 * it holds — the grant-derived default every mesh starts with.
 */
const device = (n: number, issuer = ISSUER) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: issuer.peerId, now: () => T0 });
  grants.register(grantOf(identity.peerId, issuer)).unwrap();
  const gate = createAdmissionGate({ grants, partitions: () => [ACME] });
  const attached: PeerId[] = [];
  const refused: PeerId[] = [];
  const upgrader = createUpgrader({
    identity,
    transport: "test",
    grants,
    admits: async (ask) => (await gate.admit(ask)) === "allow",
    attach: (_link, peer) => {
      attached.push(peer);
      return {
        resync: () => undefined,
        requestSnapshot: () => undefined,
        requestGrant: () => undefined,
        sendGrant: () => undefined,
        sendPresence: () => undefined,
        onError: () => () => undefined,
        flush: () => Promise.resolve(),
        close: () => undefined,
      } satisfies Bridge;
    },
  });
  return { identity, grants, upgrader, attached, refused };
};

/** Two devices on one link, each upgraded, and time for the door and a presentation to answer. */
const meet = async (x: ReturnType<typeof device>, y: ReturnType<typeof device>) => {
  const { a, b, control } = loopbackPair();
  x.upgrader.frames(a, { onRefused: (peer) => void x.refused.push(peer) });
  y.upgrader.frames(b, { onRefused: (peer) => void y.refused.push(peer) });
  for (let round = 0; round < 8; round += 1) {
    await control.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A grant reached a device only over a link its door had admitted, so two devices granted after
 * they last met each refused the other for good: neither could hand over the grant the other's
 * door was asking for (chaos soak, `--grants fault`, seed 9: a device granted mid-run whose only
 * radio neighbours never heard of it). Each end now presents its own grant as the first sealed
 * frame, and a door that refused a stranger to its registry reads it before closing.
 */
describe("a peer presents its own grant at the door", () => {
  test("two devices that never heard of each other's grants admit each other", async () => {
    const [x, y] = [device(40), device(41)];
    await meet(x, y);
    expect(x.attached).toEqual([y.identity.peerId]);
    expect(y.attached).toEqual([x.identity.peerId]);
    expect(x.grants.grantFor(y.identity.peerId)?.device).toBe(y.identity.peerId);
    expect(x.refused).toEqual([]);
  });

  test("a grant from another issuer does not open the door, and is not waited on", async () => {
    const [x, y] = [device(42), device(43, STRANGER)];
    await meet(x, y);
    expect(x.attached).toEqual([]);
    expect(x.refused).toEqual([y.identity.peerId]);
    expect(x.grants.grantFor(y.identity.peerId)).toBeUndefined();
  });
});
