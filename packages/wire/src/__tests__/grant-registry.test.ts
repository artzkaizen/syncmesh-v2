import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createGrantRegistry } from "../grant-registry.js";
import { issueGrant, type GrantRequest } from "../grant.js";
import { bytesEqual } from "../hex.js";
import { createIdentity } from "../identity.js";
import { IDENTITY_A, IDENTITY_B, SEED_B } from "./fixtures.js";

const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const T0 = at(1_700_000_000_000);
const HOUR = Temporal.Duration.from({ hours: 1 });
const ORG = parsePartitionKey("org:acme").unwrap();

const issued = (overrides: Partial<GrantRequest> = {}) =>
  issueGrant(IDENTITY_A, {
    account: "acct_b",
    device: IDENTITY_B.peerId,
    role: "member",
    partitions: [ORG],
    validFor: HOUR,
    now: T0,
    ...overrides,
  });

const registry = (start = T0) => {
  let now = start;
  const grants = createGrantRegistry({ issuer: IDENTITY_A.peerId, now: () => now });
  return { grants, set: (t: Temporal.Instant) => void (now = t) };
};

describe("GrantRegistry", () => {
  test("register verifies, holds the grant and the exact wire bytes, and notifies", () => {
    const { grants } = registry();
    const seen: string[] = [];
    grants.onRegistered((g) => void seen.push(g.role ?? ""));
    const wire = issued();
    expect(grants.register(wire).unwrap().role).toBe("member");
    expect(grants.grantFor(IDENTITY_B.peerId)?.account).toBe("acct_b");
    const held = grants.wireFor(IDENTITY_B.peerId);
    expect(held !== undefined && bytesEqual(held, wire)).toBe(true);
    expect(grants.allWires()).toHaveLength(1);
    expect(seen).toEqual(["member"]);
  });

  test("newest-issued wins: a stale replay cannot downgrade", () => {
    const { grants } = registry(at(T0.epochMilliseconds + 10_000));
    const older = issued({ role: "viewer", now: T0 });
    const newer = issued({ role: "admin", now: at(T0.epochMilliseconds + 5_000) });
    grants.register(newer).unwrap();
    expect(grants.register(older).unwrap().role).toBe("admin");
    expect(grants.grantFor(IDENTITY_B.peerId)?.role).toBe("admin");
    expect(grants.allWires()).toHaveLength(1);
  });

  test("expiry reads as absent, and a renewal replaces it", () => {
    const { grants, set } = registry();
    grants.register(issued()).unwrap();
    set(T0.add(HOUR).add(Temporal.Duration.from({ seconds: 1 })));
    expect(grants.grantFor(IDENTITY_B.peerId)).toBeUndefined();
    expect(grants.wireFor(IDENTITY_B.peerId)).toBeUndefined();
    const renewed = issued({ now: T0.add(HOUR) });
    grants.register(renewed).unwrap();
    expect(grants.grantFor(IDENTITY_B.peerId)?.issuedAt.epochMilliseconds).toBe(
      T0.add(HOUR).epochMilliseconds,
    );
  });

  test("a bad signature, a wrong issuer, or an already-expired grant is a value and changes nothing", () => {
    const { grants } = registry(at(T0.epochMilliseconds + 2 * 3_600_000));
    const forged = issueGrant(createIdentity(SEED_B).unwrap(), {
      account: "x",
      device: IDENTITY_B.peerId,
      partitions: [],
      validFor: HOUR,
      now: T0,
    });
    expect(grants.register(forged).isErr()).toBe(true);
    const expired = grants.register(issued());
    expect(expired.isErr() && expired.error._tag).toBe("GrantExpired");
    expect(grants.allWires()).toHaveLength(0);
  });

  test("revoke drops the grant locally", () => {
    const { grants } = registry();
    grants.register(issued()).unwrap();
    grants.revoke(IDENTITY_B.peerId);
    expect(grants.grantFor(IDENTITY_B.peerId)).toBeUndefined();
  });
});

describe("all", () => {
  test("every grant held, expired ones included — what a renewal loop needs to see", () => {
    const { grants, set } = registry();
    grants.register(issued()).unwrap();
    expect(grants.all()).toHaveLength(1);

    // an hour on it has lapsed: `grantFor` reads it as absent, and `all` still shows it — a
    // grant that expired while its device was dark is the one most worth renewing
    set(T0.add({ hours: 2 }));
    expect(grants.grantFor(IDENTITY_B.peerId)).toBeUndefined();
    expect(grants.all().map((g) => g.device)).toEqual([IDENTITY_B.peerId]);
  });

  test("one entry per device, newest issue: it follows the map, not the wires seen", () => {
    const { grants } = registry();
    grants.register(issued()).unwrap();
    grants.register(issued({ now: T0.add({ minutes: 5 }) })).unwrap();
    expect(grants.all()).toHaveLength(1);
    expect(grants.all()[0]?.issuedAt).toEqual(T0.add({ minutes: 5 }));
  });
});
