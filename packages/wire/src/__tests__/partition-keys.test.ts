import type { PartitionKey } from "@syncmesh/kernel";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { issueGrant, verifyGrant } from "../grant.js";
import { createIdentity } from "../identity.js";
import { createKeyRing } from "../keyring.js";
import { createPartitionKeys } from "../partition-keys.js";

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const ISSUER = createIdentity(seed(1)).unwrap();
const ALICE = createIdentity(seed(60)).unwrap();
const BOB = createIdentity(seed(120)).unwrap();
const HR = parsePartitionKey("hr:acme").unwrap();
const TEAM = parsePartitionKey("team:acme").unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const AAD = new TextEncoder().encode("aad");
const bytes = (s: string) => new TextEncoder().encode(s);

const sealedHr = (p: PartitionKey) => p === HR;

/** A ring's seal and open, which a key ring always supplies. */
const seal = (ring: ReturnType<typeof createKeyRing>, text: string) =>
  ring.crypto().seal?.(HR, bytes(text), AAD);
const open = (ring: ReturnType<typeof createKeyRing>, sealed: Uint8Array | undefined) =>
  sealed === undefined ? undefined : ring.crypto().open?.(HR, sealed, AAD);

/** A grant over `partitions` for `device`, carrying whatever `keys` wraps for it, minted `at` ms on. */
const grantFor = (
  keys: ReturnType<typeof createPartitionKeys>,
  device: typeof ALICE,
  partitions: readonly PartitionKey[],
  at: number,
) =>
  verifyGrant(
    issueGrant(ISSUER, {
      account: "acct",
      device: device.peerId,
      partitions,
      keys: keys.wrap(device.peerId, partitions),
      validFor: Temporal.Duration.from({ days: 1 }),
      now: T0.add({ milliseconds: at }),
    }),
    ISSUER.peerId,
    T0.add({ milliseconds: at }),
  ).unwrap();

describe("the issuer's partition keys (D40)", () => {
  test("only sealed partitions get keys, and the first wrap mints epoch 1", () => {
    const keys = createPartitionKeys({ sealed: sealedHr });
    expect(keys.epoch(HR)).toBeUndefined();
    const wrapped = keys.wrap(ALICE.peerId, [HR, TEAM]);
    expect(wrapped.map((k) => [k.partition, k.epoch])).toEqual([[HR, 1]]);
    expect(keys.epoch(HR)).toBe(1);
    expect(keys.epoch(TEAM)).toBeUndefined();
  });

  test("a removed member reads what was written before the rotation and nothing after", () => {
    const keys = createPartitionKeys({ sealed: sealedHr });
    const alice = createKeyRing(ALICE);
    const bob = createKeyRing(BOB);
    alice.learn(grantFor(keys, ALICE, [HR], 0));
    bob.learn(grantFor(keys, BOB, [HR], 0));

    const before = seal(alice, "salary review, before");
    expect(before).toBeDefined();
    expect(open(bob, before)).toEqual(bytes("salary review, before"));

    // Bob leaves HR: his grant is re-issued without it, the partition rotates, Alice is re-issued
    keys.rotate(HR);
    alice.learn(grantFor(keys, ALICE, [HR], 1000));
    expect(alice.epochFor(HR)).toBe(2);

    const after = seal(alice, "salary review, after");
    expect(after).toBeDefined();
    expect(open(bob, after)).toBeUndefined();
    // and Alice still reads the history her own device carries
    expect(open(alice, before)).toEqual(bytes("salary review, before"));
    expect(open(alice, after)).toEqual(bytes("salary review, after"));
  });

  test("a member admitted after a rotation is wrapped every epoch, so it reads the history too", () => {
    const keys = createPartitionKeys({ sealed: sealedHr });
    const alice = createKeyRing(ALICE);
    alice.learn(grantFor(keys, ALICE, [HR], 0));
    const old = seal(alice, "old");
    keys.rotate(HR);
    const bob = createKeyRing(BOB);
    bob.learn(grantFor(keys, BOB, [HR], 1000));
    expect(keys.wrap(BOB.peerId, [HR]).map((k) => k.epoch)).toEqual([1, 2]);
    expect(open(bob, old)).toEqual(bytes("old"));
  });

  test("held keys restore: an issuer that persisted them wraps the same keys after a restart", () => {
    const first = createPartitionKeys({ sealed: sealedHr });
    const alice = createKeyRing(ALICE);
    alice.learn(grantFor(first, ALICE, [HR], 0));
    const sealed = seal(alice, "kept");
    first.rotate(HR);

    const restarted = createPartitionKeys({ sealed: sealedHr, held: first.held() });
    expect(restarted.epoch(HR)).toBe(2);
    const bob = createKeyRing(BOB);
    bob.learn(grantFor(restarted, BOB, [HR], 1000));
    expect(open(bob, sealed)).toEqual(bytes("kept"));
  });
});
