import { createLink, type Quarantined } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "member"] },
    tables: {
      controls: {
        columns: { id: t.text().primaryKey(), title: t.text(), by: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** What the auth route does, wherever the issuer key lives: a server, or the owner's phone. */
const mintFor = (issuer: Identity, account: string, device: Identity, role: string) =>
  issueGrant(issuer, {
    account,
    device: device.peerId,
    role,
    // SAFETY: test fixture instance in the documented kind:id form
    partitions: ["org:acme"] as never,
    validFor: Temporal.Duration.from({ days: 30 }),
    now: T0,
  });

const open = (identity: Identity, issuer: Identity) =>
  createMesh({ schema: schema(), identity, issuer: issuer.peerId, now: () => T0 });

describe("onboarding through the mesh — a grant is bytes, any peer can carry them", () => {
  test("S2: no internet on the new device; a peer relays the request and the signed grant back", async () => {
    const issuer = createIdentity(seed(1)).unwrap(); // the server's key
    const member = createIdentity(seed(40)).unwrap(); // M: online, already granted
    const newcomer = createIdentity(seed(80)).unwrap(); // N: offline, new account

    const m = open(member, issuer);
    m.grants.register(mintFor(issuer, "acct_m", member, "member")).unwrap();

    // N is fully offline: identity minted locally, nothing writable in the org yet
    const n = open(newcomer, issuer);
    expect((await n.controls.insert({ id: "c1", title: "x", by: "acct_n" })).isErr()).toBe(true);
    expect(n.can("controls.insert")).toBe(false);

    // BLE hop 1: N -> M carries only N's peerId. M has internet and calls the grant
    // route with N's peerId — the route from use-cases §1, verbatim.
    const wire = mintFor(issuer, "acct_n", newcomer, "member");
    // BLE hop 2: M -> N carries the signed grant; N verifies it offline.
    const grant = n.grants.register(wire).unwrap();
    expect(grant.account).toBe("acct_n");
    n.activate("org:acme").unwrap();

    // N can now write, and M accepts N's events once the same bytes reach M (grants-first).
    m.grants.register(wire).unwrap();
    const written = (await n.controls.insert({ id: "c1", title: "x", by: "acct_n" })).unwrap();
    expect(written.title).toBe("x");
    const link = createLink(n.engine, m.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    m.activate("org:acme").unwrap();
    expect(m.controls.byId("c1")?.title).toBe("x");
  });

  test("S2 hostile relay: the carrier can neither tamper with a grant nor use one not its own", () => {
    const issuer = createIdentity(seed(1)).unwrap();
    const newcomer = createIdentity(seed(80)).unwrap();
    const carrier = createIdentity(seed(120)).unwrap();

    const wire = mintFor(issuer, "acct_n", newcomer, "member");
    const tampered = Uint8Array.from(wire);
    // SAFETY: flipping one payload byte to prove the signature covers it
    tampered[tampered.length - 20] = (tampered[tampered.length - 20]! + 1) % 256;

    const n = open(newcomer, issuer);
    expect(n.grants.register(tampered).isErr()).toBe(true);

    // the carrier registering N's grant gains nothing: the grant names N's device key
    const c = open(carrier, issuer);
    c.grants.register(wire).unwrap();
    expect(c.can("controls.insert")).toBe(false);
  });

  test("S3 serverless org: the issuer key lives on the owner's phone, grants minted in the room", async () => {
    const ownerPhone = createIdentity(seed(7)).unwrap(); // issuer AND a device
    const staff = createIdentity(seed(160)).unwrap();

    const owner = createMesh({
      schema: schema(),
      identity: ownerPhone,
      issuer: ownerPhone.peerId,
      issuerKey: ownerPhone,
      now: () => T0,
    });
    owner.grants
      .issue({
        account: "acct_owner",
        device: ownerPhone.peerId,
        role: "owner",
        partitions: ["org:acme"],
        validFor: Temporal.Duration.from({ days: 30 }),
      })
      .unwrap();
    // the approval tap (flow B step ②): mint for the staff phone's peerId, send the bytes back
    const staffGrant = owner.grants
      .issue({
        account: "acct_staff",
        device: staff.peerId,
        role: "member",
        partitions: ["org:acme"],
        validFor: Temporal.Duration.from({ days: 30 }),
      })
      .unwrap();

    const s = open(staff, ownerPhone);
    s.grants.register(staffGrant).unwrap();
    s.activate("org:acme").unwrap();
    (await s.controls.insert({ id: "c1", title: "minted offline", by: "acct_staff" })).unwrap();

    // the owner already holds the staff grant (issue registers it) — staff events fold at once
    const link = createLink(s.engine, owner.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    owner.activate("org:acme").unwrap();
    expect(owner.controls.byId("c1")?.title).toBe("minted offline");
  });

  test("S3 guards: no issuerKey panics, a mismatched issuerKey panics, a bad partition is a value", () => {
    const issuer = createIdentity(seed(1)).unwrap();
    const device = createIdentity(seed(40)).unwrap();
    const plain = open(device, issuer);
    expect(() =>
      plain.grants.issue({
        account: "a",
        device: device.peerId,
        partitions: ["org:acme"],
        validFor: Temporal.Duration.from({ days: 1 }),
      }),
    ).toThrow("issuerKey");
    expect(() =>
      createMesh({
        schema: schema(),
        identity: device,
        issuer: issuer.peerId,
        issuerKey: device,
        now: () => T0,
      }),
    ).toThrow("does not match");

    const owner = createMesh({
      schema: schema(),
      identity: issuer,
      issuer: issuer.peerId,
      issuerKey: issuer,
      now: () => T0,
    });
    const bad = owner.grants.issue({
      account: "a",
      device: device.peerId,
      partitions: ["not a key"],
      validFor: Temporal.Duration.from({ days: 1 }),
    });
    expect(bad.isErr() && bad.error._tag).toBe("InvalidPartitionKey");
  });

  test("S4 grants-first: an author's events quarantine on NoGrant until the grant frame lands, then a resync converges", async () => {
    const issuer = createIdentity(seed(1)).unwrap();
    const a = createIdentity(seed(40)).unwrap();
    const b = createIdentity(seed(80)).unwrap();

    const meshA = open(a, issuer);
    const meshB = open(b, issuer);
    const grantA = mintFor(issuer, "acct_a", a, "member");
    meshA.grants.register(grantA).unwrap();
    meshA.activate("org:acme").unwrap();
    (await meshA.controls.insert({ id: "c1", title: "early", by: "acct_a" })).unwrap();

    const quarantined: Quarantined[] = [];
    meshB.engine.onQuarantine((q) => void quarantined.push(q));
    const first = createLink(meshA.engine, meshB.engine, { now: () => T0 });
    (await first.catchUp()).unwrap();
    expect(quarantined.map((q) => q.reason._tag)).toEqual(["NoGrant"]);
    expect(meshB.engine.state().size).toBe(0);
    first.close();

    // the grant frame arrives (E11 sends it before any event); a fresh session resyncs
    meshB.grants.register(grantA).unwrap();
    const second = createLink(meshA.engine, meshB.engine, { now: () => T0 });
    (await second.catchUp()).unwrap();
    meshB.activate("org:acme").unwrap();
    expect(meshB.controls.byId("c1")?.title).toBe("early");
  });
});
