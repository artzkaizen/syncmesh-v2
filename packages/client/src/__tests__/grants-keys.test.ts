import { parsePartitionKey, type PartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Temporal } from "@syncmesh/temporal";
import {
  createGrantRegistry,
  createIdentity,
  createKeyRing,
  createPartitionKeys,
  verifyGrant,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMeshGrants } from "../grants.js";

const ISSUER = createIdentity(seed(1)).unwrap();
const ALICE = createIdentity(seed(60)).unwrap();
const BOB = createIdentity(seed(120)).unwrap();
const HR = parsePartitionKey("hr:acme").unwrap();
const TEAM = parsePartitionKey("team:acme").unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const AAD = new TextEncoder().encode("aad");
const text = (s: string) => new TextEncoder().encode(s);

/** The issuer's grants on a clock the test moves, with HR sealed. */
const issuerGrants = () => {
  let now = T0;
  const registry = createGrantRegistry({ issuer: ISSUER.peerId, now: () => now });
  const grants = createMeshGrants(registry, {
    issuerKey: ISSUER,
    now: () => now,
    partitionKeys: createPartitionKeys({ sealed: (p: PartitionKey) => p === HR }),
  });
  return {
    grants,
    tick: (ms: number) => void (now = now.add({ milliseconds: ms })),
    at: () => now,
  };
};

const day = Temporal.Duration.from({ days: 1 });

describe("grants carry the keys of the sealed partitions they admit (D40)", () => {
  test("issue wraps a key only for the sealed partitions it names", () => {
    const { grants, at } = issuerGrants();
    const wire = grants
      .issue({ account: "a", device: ALICE.peerId, partitions: [HR, TEAM], validFor: day })
      .unwrap();
    const grant = verifyGrant(wire, ISSUER.peerId, at()).unwrap();
    expect(grant.keys?.map((k) => [k.partition, k.epoch])).toEqual([[HR, 1]]);
  });

  test("rekey re-issues to the members still in the partition, at their own expiry, and not to the one removed", () => {
    const { grants, tick, at } = issuerGrants();
    grants
      .issue({ account: "a", device: ALICE.peerId, partitions: [HR, TEAM], validFor: day })
      .unwrap();
    grants
      .issue({ account: "b", device: BOB.peerId, partitions: [HR, TEAM], validFor: day })
      .unwrap();
    const alice = createKeyRing(ALICE);
    const bob = createKeyRing(BOB);
    for (const grant of grants.all()) {
      alice.learn(grant);
      bob.learn(grant);
    }
    const before = alice.crypto().seal?.(HR, text("before"), AAD);

    tick(1000);
    // Bob leaves HR, then the partition turns
    grants.issue({ account: "b", device: BOB.peerId, partitions: [TEAM], validFor: day }).unwrap();
    const reissued = grants.rekey(HR).unwrap();
    const minted = reissued.map((wire) => verifyGrant(wire, ISSUER.peerId, at()).unwrap());
    expect(minted.map((g) => g.device)).toEqual([ALICE.peerId]);
    // a rotation is not a renewal: Alice's grant ends when it was going to
    expect(minted[0]?.expiresAt.epochMilliseconds).toBe(T0.add({ hours: 24 }).epochMilliseconds);
    for (const grant of minted) alice.learn(grant);
    expect(alice.epochFor(HR)).toBe(2);

    const after = alice.crypto().seal?.(HR, text("after"), AAD);
    if (before === undefined || after === undefined) throw new Error("alice holds the hr key");
    expect(bob.crypto().open?.(HR, before, AAD)).toEqual(text("before"));
    expect(bob.crypto().open?.(HR, after, AAD)).toBeUndefined();
  });

  test("renew carries the keys forward, every epoch of them", () => {
    const { grants, tick, at } = issuerGrants();
    grants.issue({ account: "a", device: ALICE.peerId, partitions: [HR], validFor: day }).unwrap();
    tick(1000);
    grants.rekey(HR).unwrap();
    tick(1000);
    const renewed = verifyGrant(grants.renew(ALICE.peerId, day).unwrap(), ISSUER.peerId, at());
    expect(renewed.unwrap().keys?.map((k) => k.epoch)).toEqual([1, 2]);
  });
});
