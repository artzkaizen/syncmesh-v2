import { seed } from "@syncmesh/kernel/test-fixtures";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { linkTransport, loopbackPair, type LoopbackControl } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const settle = async (control: LoopbackControl) => {
  for (let round = 0; round < 8; round += 1) {
    await control.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** Two meshes joined by one loopback radio; the owner holds the issuer key. */
const room = async (options?: { readonly grantStaff?: boolean }) => {
  const ownerId = createIdentity(seed(7)).unwrap();
  const staffId = createIdentity(seed(160)).unwrap();
  const { a, b, control } = loopbackPair();

  const owner = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: ownerId,
      issuer: ownerId.peerId,
      issuerKey: ownerId,
      now: () => T0,
      transports: [linkTransport("loopback:owner", () => a)],
      onGrantRequest: ({ peerId, invite }) => {
        if (invite !== "inv-42") return; // Q1: the invite token is the account proof
        owner.grants
          .issue({
            account: "acct_staff",
            device: peerId,
            role: "member",
            partitions: ["org:acme"],
            validFor: Temporal.Duration.from({ days: 1 }),
          })
          .unwrap();
      },
    })
  ).unwrap();
  owner.grants
    .issue({
      account: "acct_owner",
      device: ownerId.peerId,
      role: "owner",
      partitions: ["org:acme"],
      validFor: Temporal.Duration.from({ days: 1 }),
    })
    .unwrap();

  const staff = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: staffId,
      issuer: ownerId.peerId,
      now: () => T0,
      transports: [linkTransport("loopback:staff", () => b)],
    })
  ).unwrap();
  if (options?.grantStaff !== false) {
    staff.grants
      .register(
        owner.grants
          .issue({
            account: "acct_staff",
            device: staffId.peerId,
            role: "member",
            partitions: ["org:acme"],
            validFor: Temporal.Duration.from({ days: 1 }),
          })
          .unwrap(),
      )
      .unwrap();
  }
  return { owner, staff, staffId, control };
};

describe("createMesh over transports", () => {
  test("two meshes converge; a live query on one notifies for the other's write", async () => {
    const { owner, staff, control } = await room();
    await owner.ready();
    await staff.ready();
    await settle(control);

    const ho = owner.on("org:acme").unwrap();
    const hs = staff.on("org:acme").unwrap();
    const list = ho.live(ho.db.select().from(notes));
    expect(await list.ready).toEqual([]);
    let notified = 0;
    list.subscribe(() => void (notified += 1));

    await hs.db.insert(notes).values({ id: "n1", body: "from-staff" });
    await settle(control);
    expect((await ho.db.select().from(notes)).map((r) => r.body)).toEqual(["from-staff"]);
    expect(notified).toBe(1);
    list.release();
    await owner.stop();
    await staff.stop();
  });

  test("flow A at the API: requestGrant with the invite lights the newcomer up", async () => {
    const { owner, staff, control } = await room({ grantStaff: false });
    await Promise.all([owner.ready(), staff.ready()]);
    await settle(control);
    expect(staff.can("notes.insert")).toBe(false);

    staff.requestGrant("bad-invite");
    await settle(control);
    expect(staff.can("notes.insert")).toBe(false); // refused: the invite is the account proof

    staff.requestGrant("inv-42");
    await settle(control);
    expect(staff.can("notes.insert")).toBe(true);
    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "n1", body: "onboarded" });
    await settle(control);
    const ho = owner.on("org:acme").unwrap();
    expect((await ho.db.select().from(notes)).map((r) => r.body)).toEqual(["onboarded"]);
    await owner.stop();
    await staff.stop();
  });

  test("stop() closes the sessions: later writes stay local and running() flips", async () => {
    const { owner, staff, control } = await room();
    await Promise.all([owner.ready(), staff.ready()]);
    await settle(control);
    expect(staff.running()).toBe(true);
    await staff.stop();
    expect(staff.running()).toBe(false);

    // the driver is ours, so the local surface outlives stop(); only the radio is gone
    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "n2", body: "offline" });
    await settle(control);
    const ho = owner.on("org:acme").unwrap();
    expect(await ho.db.select().from(notes)).toHaveLength(0);
    await owner.stop();
  });
});
