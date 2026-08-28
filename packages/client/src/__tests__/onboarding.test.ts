import { createLink, type Quarantined } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

const controls = sqliteTable("controls", {
  id: text().primaryKey(),
  title: text().notNull(),
  by: text().notNull(),
});
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

const open = async (identity: Identity, issuer: Identity) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();

const titleOf = async (mesh: Awaited<ReturnType<typeof open>>, id: string) => {
  const { db } = mesh.on("org:acme").unwrap();
  const rows = await db.select().from(controls);
  return rows.find((r) => r.id === id)?.title;
};

describe("onboarding through the mesh — a grant is bytes, any peer can carry them", () => {
  test("S2: no internet on the new device; a peer relays the request and the signed grant back", async () => {
    const issuer = createIdentity(seed(1)).unwrap(); // the server's key
    const member = createIdentity(seed(40)).unwrap(); // M: online, already granted
    const newcomer = createIdentity(seed(80)).unwrap(); // N: offline, new account

    const m = await open(member, issuer);
    m.grants.register(mintFor(issuer, "acct_m", member, "member")).unwrap();

    // N is fully offline: identity minted locally, nothing writable in the org yet
    const n = await open(newcomer, issuer);
    const hn = n.on("org:acme").unwrap();
    const refused = await hn.db
      .insert(controls)
      .values({ id: "c1", title: "x", by: "acct_n" })
      .then(() => "ok")
      .catch(() => "refused");
    expect(refused).toBe("refused");
    expect(n.can("controls.insert")).toBe(false);

    // BLE hop 1: N -> M carries only N's peerId. M has internet and calls the grant
    // route with N's peerId — the route from use-cases §1, verbatim.
    const wire = mintFor(issuer, "acct_n", newcomer, "member");
    // BLE hop 2: M -> N carries the signed grant; N verifies it offline.
    const grant = n.grants.register(wire).unwrap();
    expect(grant.account).toBe("acct_n");

    // N can now write, and M accepts N's events once the same bytes reach M (grants-first).
    m.grants.register(wire).unwrap();
    await hn.db.insert(controls).values({ id: "c1", title: "x", by: "acct_n" });
    expect(await titleOf(n, "c1")).toBe("x");
    const link = createLink(n.engine, m.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    expect(await titleOf(m, "c1")).toBe("x");
  });

  test("S2 hostile relay: the carrier can neither tamper with a grant nor use one not its own", async () => {
    const issuer = createIdentity(seed(1)).unwrap();
    const newcomer = createIdentity(seed(80)).unwrap();
    const carrier = createIdentity(seed(120)).unwrap();

    const wire = mintFor(issuer, "acct_n", newcomer, "member");
    const tampered = Uint8Array.from(wire);
    // SAFETY: flipping one payload byte to prove the signature covers it
    tampered[tampered.length - 20] = (tampered[tampered.length - 20]! + 1) % 256;

    const n = await open(newcomer, issuer);
    expect(n.grants.register(tampered).isErr()).toBe(true);

    // the carrier registering N's grant gains nothing: the grant names N's device key
    const c = await open(carrier, issuer);
    c.grants.register(wire).unwrap();
    expect(c.can("controls.insert")).toBe(false);
  });

  test("S3 serverless org: the issuer key lives on the owner's phone, grants minted in the room", async () => {
    const ownerPhone = createIdentity(seed(7)).unwrap(); // issuer AND a device
    const staff = createIdentity(seed(160)).unwrap();

    const owner = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: ownerPhone,
        issuer: ownerPhone.peerId,
        issuerKey: ownerPhone,
        now: () => T0,
      })
    ).unwrap();
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

    const s = await open(staff, ownerPhone);
    s.grants.register(staffGrant).unwrap();
    const hs = s.on("org:acme").unwrap();
    await hs.db.insert(controls).values({ id: "c1", title: "minted offline", by: "acct_staff" });

    // the owner already holds the staff grant (issue registers it) — staff events fold at once
    const link = createLink(s.engine, owner.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    expect(await titleOf(owner, "c1")).toBe("minted offline");
  });

  test("S3 guards: no issuerKey panics, a mismatched issuerKey panics, a bad partition is a value", async () => {
    const issuer = createIdentity(seed(1)).unwrap();
    const device = createIdentity(seed(40)).unwrap();
    const plain = await open(device, issuer);
    expect(() =>
      plain.grants.issue({
        account: "a",
        device: device.peerId,
        partitions: ["org:acme"],
        validFor: Temporal.Duration.from({ days: 1 }),
      }),
    ).toThrow("issuerKey");
    const mismatched = await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      issuerKey: device,
      now: () => T0,
    }).catch((cause: unknown) => cause);
    expect(mismatched).toBeInstanceOf(Error);
    expect(String(mismatched)).toContain("does not match");

    const owner = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: issuer,
        issuer: issuer.peerId,
        issuerKey: issuer,
        now: () => T0,
      })
    ).unwrap();
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

    const meshA = await open(a, issuer);
    const meshB = await open(b, issuer);
    const grantA = mintFor(issuer, "acct_a", a, "member");
    meshA.grants.register(grantA).unwrap();
    const ha = meshA.on("org:acme").unwrap();
    await ha.db.insert(controls).values({ id: "c1", title: "early", by: "acct_a" });

    const quarantined: Quarantined[] = [];
    meshB.engine.onQuarantine((q) => void quarantined.push(q));
    const first = createLink(meshA.engine, meshB.engine, { now: () => T0 });
    (await first.catchUp()).unwrap();
    expect(quarantined.map((q) => q.reason._tag)).toEqual(["NoGrant"]);
    expect(meshB.engine.state().size).toBe(0);
    first.close();

    // the grant frame arrives before any event; a fresh session resyncs
    meshB.grants.register(grantA).unwrap();
    const second = createLink(meshA.engine, meshB.engine, { now: () => T0 });
    (await second.catchUp()).unwrap();
    expect(await titleOf(meshB, "c1")).toBe("early");
  });
});
