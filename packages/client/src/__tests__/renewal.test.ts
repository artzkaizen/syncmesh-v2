import { revokeDevice, setPolicy } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const ISSUER = createIdentity(seed(1)).unwrap();
const PHONE = createIdentity(seed(90)).unwrap();
const TABLET = createIdentity(seed(120)).unwrap();
const LAPTOP = createIdentity(seed(160)).unwrap();
const STRANGER = createIdentity(seed(200)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

const CLAIMS = { tier: "pro", seats: 3 } as const;

/** The authority: the one process that holds the issuer's private half, so `issue` is unlocked. */
const authority = async () => {
  const clock = { now: T0 };
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: ISSUER,
      issuer: ISSUER.peerId,
      issuerKey: ISSUER,
      authority: ISSUER.peerId, // the same process governs the instance it mints for
      now: () => clock.now,
    })
  ).unwrap();
  return { mesh, clock };
};

/**
 * The authority, plus the ordinary grant it needs to write `_revocations` and `_policy` at all —
 * it is a peer like any other, and being named `authority` is a power, not an exemption.
 */
const governing = async () => {
  const held = await authority();
  held.mesh.grants
    .issue({
      account: "acct_a",
      device: ISSUER.peerId,
      role: "member",
      partitions: ["org:acme", "org:globex"],
      validFor: Temporal.Duration.from({ hours: 1 }), // long, so it never joins an `expiring` window
    })
    .unwrap();
  return held;
};

const grant = (device: typeof PHONE, validFor: Temporal.Duration) => ({
  account: "acct_a",
  device: device.peerId,
  role: "member",
  partitions: ["org:acme"],
  claims: CLAIMS,
  validFor,
});

const MINUTES = (n: number) => Temporal.Duration.from({ minutes: n });

describe("renewal on the authority", () => {
  test("expiring finds what lapses inside the window, soonest first", async () => {
    const { mesh } = await authority();
    mesh.grants.issue(grant(PHONE, MINUTES(45))).unwrap();
    mesh.grants.issue(grant(TABLET, MINUTES(20))).unwrap();
    mesh.grants.issue(grant(LAPTOP, Temporal.Duration.from({ days: 30 }))).unwrap();

    const soon = mesh.grants.expiring(Temporal.Duration.from({ hours: 1 }));
    expect(soon.map((g) => g.device)).toEqual([TABLET.peerId, PHONE.peerId]);
    await mesh.stop();
  });

  test("renew carries account, role, partitions and claims over", async () => {
    const { mesh, clock } = await authority();
    mesh.grants.issue(grant(PHONE, MINUTES(30))).unwrap();

    clock.now = T0.add({ minutes: 20 });
    mesh.grants.renew(PHONE.peerId, Temporal.Duration.from({ days: 1 })).unwrap();

    const renewed = mesh.grants.grantFor(PHONE.peerId);
    expect(renewed?.account).toBe("acct_a");
    expect(renewed?.role).toBe("member");
    expect(renewed?.partitions).toEqual([ACME]);
    // the field a hand-rolled re-issue drops, taking the `allow` rules that read it with it
    expect(renewed?.claims).toEqual(CLAIMS);
    await mesh.stop();
  });

  test("the renewed grant supersedes the old one rather than joining it", async () => {
    const { mesh, clock } = await authority();
    mesh.grants.issue(grant(PHONE, MINUTES(30))).unwrap();

    clock.now = T0.add({ minutes: 20 });
    mesh.grants.renew(PHONE.peerId, Temporal.Duration.from({ days: 1 })).unwrap();

    expect(mesh.grants.allWires()).toHaveLength(1);
    expect(mesh.grants.grantFor(PHONE.peerId)?.issuedAt).toEqual(T0.add({ minutes: 20 }));
    expect(mesh.grants.grantFor(PHONE.peerId)?.expiresAt).toEqual(
      T0.add({ minutes: 20 }).add({ hours: 24 }),
    );
    await mesh.stop();
  });

  test("a renewal keeps a live device working across the boundary", async () => {
    const { mesh, clock } = await authority();
    mesh.grants.issue(grant(PHONE, MINUTES(30))).unwrap();
    mesh.grants.issue(grant(TABLET, MINUTES(30))).unwrap();

    // the loop: at twenty minutes the authority asks who lapses within the hour and renews
    clock.now = T0.add({ minutes: 20 });
    for (const due of mesh.grants.expiring(Temporal.Duration.from({ hours: 1 })))
      if (due.device === PHONE.peerId)
        mesh.grants.renew(due.device, Temporal.Duration.from({ days: 1 })).unwrap();

    // past the original expiry: the renewed device is still an author, the untouched one is not
    clock.now = T0.add({ minutes: 45 });
    expect(mesh.grants.grantFor(PHONE.peerId)?.account).toBe("acct_a");
    expect(mesh.grants.grantFor(TABLET.peerId)).toBeUndefined();
    await mesh.stop();
  });

  test("renewing a device no grant is held for is a typed error", async () => {
    const { mesh } = await authority();
    const failed = mesh.grants.renew(STRANGER.peerId, Temporal.Duration.from({ days: 1 }));
    expect(failed.isErr() && failed.error._tag).toBe("NoGrantHeld");
    await mesh.stop();
  });
});

describe("renewal and revocation", () => {
  test("the loop does not readmit a device the authority revoked", async () => {
    const { mesh, clock } = await governing();
    mesh.grants.issue(grant(PHONE, MINUTES(10))).unwrap();

    // the phone is reported stolen, and the authority says so in the log
    (
      await revokeDevice(mesh.engine, {
        device: PHONE.peerId,
        partition: ACME,
        reason: "reported stolen",
        at: T0.add({ minutes: 1 }),
      })
    ).unwrap();

    // an unrevoked device is still listed and still renewable, so the loop keeps working
    mesh.grants.issue(grant(LAPTOP, MINUTES(10))).unwrap();
    clock.now = T0.add({ minutes: 9 });
    expect(mesh.grants.expiring(MINUTES(5)).map((g) => g.device)).toEqual([LAPTOP.peerId]);

    // and the phone cannot be renewed into the room it was thrown out of. A deliberate `issue`
    // still can — that is the path that should need someone to mean it
    const refused = mesh.grants.renew(PHONE.peerId, MINUTES(10));
    expect(refused.isErr() && refused.error._tag).toBe("DeviceRevoked");
    expect(mesh.grants.issue(grant(PHONE, MINUTES(10))).isOk()).toBe(true);
    await mesh.stop();
  });

  test("a revocation in one instance does not stop renewal for a grant that never covered it", async () => {
    const { mesh, clock } = await governing();
    mesh.grants.issue(grant(TABLET, MINUTES(10))).unwrap();
    (
      await revokeDevice(mesh.engine, {
        device: TABLET.peerId,
        partition: GLOBEX,
        reason: "left that org",
        at: T0.add({ minutes: 1 }),
      })
    ).unwrap();
    clock.now = T0.add({ minutes: 9 });
    expect(mesh.grants.renew(TABLET.peerId, MINUTES(10)).isOk()).toBe(true);
    await mesh.stop();
  });

  test("a grant already lapsed is still visible and still renewable", async () => {
    const { mesh, clock } = await authority();
    mesh.grants.issue(grant(PHONE, MINUTES(10))).unwrap();
    clock.now = T0.add({ minutes: 30 }); // long past expiry: the device went dark

    expect(mesh.grants.grantFor(PHONE.peerId)).toBeUndefined(); // expiry reads as absent
    expect(mesh.grants.expiring(MINUTES(1)).map((g) => g.device)).toEqual([PHONE.peerId]);
    expect(mesh.grants.renew(PHONE.peerId, MINUTES(10)).isOk()).toBe(true);
    expect(mesh.grants.grantFor(PHONE.peerId)?.claims).toEqual(CLAIMS);
    await mesh.stop();
  });

  test("expiring counts the grace an instance declared, not just the expiry", async () => {
    const { mesh, clock } = await governing();
    mesh.grants.issue(grant(PHONE, MINUTES(10))).unwrap();
    clock.now = T0.add({ minutes: 2 });
    // eight minutes of validity left, and nothing due inside the next minute
    expect(mesh.grants.expiring(MINUTES(1))).toEqual([]);

    // the instance declares that it stops trusting a grant five minutes before it lapses, so
    // the same grant is now three minutes from being refused rather than eight from expiring
    (await setPolicy(mesh.engine, ACME, {}, { grace: MINUTES(5) })).unwrap();
    expect(mesh.grants.expiring(MINUTES(4)).map((g) => g.device)).toEqual([PHONE.peerId]);
    await mesh.stop();
  });
});
