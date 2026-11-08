import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { memoryGrantStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { rememberGrants } from "../grants.js";

const ISSUER = createIdentity(seed(1)).unwrap();
const DEVICE = createIdentity(seed(90)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const PAYROLL = parsePartitionKey("org:payroll").unwrap();

const mint = (partitions: readonly (typeof ACME)[], at: number) =>
  issueGrant(ISSUER, {
    account: "acct_a",
    device: DEVICE.peerId,
    role: "member",
    partitions,
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0.add({ milliseconds: at }),
  });

describe("a narrower grant is kept only once its purge is done (D45)", () => {
  test("the store holds the wider grant until the purge settles, then the narrower one", async () => {
    const registry = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
    const store = memoryGrantStore();
    let finish = (): void => undefined;
    const purging = new Promise<void>((resolve) => (finish = resolve));
    let settled = (): Promise<void> => Promise.resolve();
    (await rememberGrants(registry, store, () => settled())).unwrap();

    const wide = mint([ACME, PAYROLL], 0);
    registry.register(wide).unwrap();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.all()).unwrap()).toEqual([wide]);

    // the narrowing starts a purge; until it settles, a restart must find the wider grant, so it
    // learns of the narrowing again and purges then
    settled = () => purging;
    registry.register(mint([ACME], 1)).unwrap();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.all()).unwrap()).toEqual([wide]);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.all()).unwrap()).toEqual([mint([ACME], 1)]);
  });
});
