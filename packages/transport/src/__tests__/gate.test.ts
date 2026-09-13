import type { PeerId } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createAdmissionGate } from "../gate.js";

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const member = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const stranger = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** A registry holding one grant: `member` is in `org:acme`, nobody else is in anything. */
const registry = (partitions: readonly string[] = ["org:acme"]) => {
  const held = createGrantRegistry({ issuer: issuer.peerId, now: () => T0 });
  held
    .register(
      issueGrant(issuer, {
        account: "acct",
        device: member.peerId,
        role: "member",
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: partitions as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
        claims: { site: "lagos" },
      }),
    )
    .unwrap();
  return held;
};

const ask = (peer: PeerId, requesting?: boolean) => {
  const asked = { peer, transport: "ble" };
  if (requesting !== undefined) Object.assign(asked, { requesting });
  return asked;
};

describe("the admission gate — the door, derived from grants (book ch. 14)", () => {
  test("an overlapping grant opens it; a stranger gets no link at all", async () => {
    const gate = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
    });
    expect(await gate.admit(ask(member.peerId))).toBe("allow");
    // the lobby, answered with no code: the other company's phone holds no overlapping grant
    expect(await gate.admit(ask(stranger.peerId))).toBe("deny");
  });

  test("a grant for somebody else's partitions is not a key to ours", async () => {
    const gate = createAdmissionGate({
      grants: registry(["org:other"]),
      partitions: () => ["org:acme"],
    });
    expect(await gate.admit(ask(member.peerId))).toBe("deny");
  });

  test("asking for a grant is the one corridor a stranger has", async () => {
    const gate = createAdmissionGate({ grants: registry(), partitions: () => ["org:acme"] });
    // forced: a joining device must be able to ask before it holds anything
    expect(await gate.admit(ask(stranger.peerId, true))).toBe("allow");
  });

  test("a handler may only tighten: it overrides an allow and never manufactures one", async () => {
    const denyOnSite = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
      // "no BLE links inside this facility" — a policy about the radio, not about who belongs
      handler: ({ vouched }) => (vouched.site === "lagos" ? "deny" : "allow"),
    });
    expect(await denyOnSite.admit(ask(member.peerId))).toBe("deny");

    const permissive = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
      handler: () => "allow",
    });
    expect(await permissive.admit(ask(stranger.peerId))).toBe("deny"); // still no grant
  });

  test("a different fleet is passed over — an optimization, never a control", async () => {
    const depot = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
      group: "depot",
    });
    // the same grant, the same partitions: only the fleet differs, and a slot is not spent
    expect(await depot.admit({ peer: member.peerId, transport: "ble", group: "warehouse" })).toBe(
      "deny",
    );
    expect(await depot.admit({ peer: member.peerId, transport: "ble", group: "depot" })).toBe(
      "allow",
    );
    // a medium that carries no group says nothing, and the grant decides as it always did
    expect(await depot.admit(ask(member.peerId))).toBe("allow");
  });

  test("it fails closed: a thrower denies, and so does a handler that never answers", async () => {
    const threw = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
      handler: () => {
        throw new Error("the policy code is broken");
      },
    });
    expect(await threw.admit(ask(member.peerId))).toBe("deny");

    const hung = createAdmissionGate({
      grants: registry(),
      partitions: () => ["org:acme"],
      handler: () => new Promise<"allow">(() => undefined), // never settles
      within: Temporal.Duration.from({ milliseconds: 20 }),
    });
    expect(await hung.admit(ask(member.peerId))).toBe("deny");
  });
});
