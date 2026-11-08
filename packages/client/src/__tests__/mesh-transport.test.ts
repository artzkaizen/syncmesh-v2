import { seed } from "@syncmesh/kernel/test-fixtures";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { linkTransport, loopbackPair, type LoopbackControl } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { MeshStopped } from "../errors.js";
import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("owner", "member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
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
const room = async (options?: { readonly grantStaff?: boolean; readonly start?: boolean }) => {
  const start = options?.start ?? true;
  const ownerId = createIdentity(seed(7)).unwrap();
  const staffId = createIdentity(seed(160)).unwrap();
  const { a, b, control } = loopbackPair();

  const owner = (
    await createMesh({
      schema: schema(),
      identity: ownerId,
      now: () => T0,
      transports: [linkTransport("loopback:owner", () => a)],
      start,
      admission: ({ peerId, invite }) => {
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
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { issuer: ownerId.peerId, issuerKey: ownerId },
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
      schema: schema(),
      identity: staffId,
      now: () => T0,
      transports: [linkTransport("loopback:staff", () => b)],
      start,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { issuer: ownerId.peerId },
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

describe("runtime transports (book ch. 8)", () => {
  test("a radio added mid-life carries the mesh; removing one removes a route, never rows", async () => {
    const { owner, staff, control } = await room();
    await owner.ready();
    await staff.ready();
    await settle(control);

    const ho = owner.on("org:acme").unwrap();
    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "first", body: "over the original radio" });
    await settle(control);
    expect((await ho.db.select().from(notes)).map((r) => r.id)).toEqual(["first"]);

    // a second radio pair appears after construction — the settings-screen toggle
    const late = loopbackPair();
    (await owner.transports.add(linkTransport("late:owner", () => late.a))).unwrap();
    (await staff.transports.add(linkTransport("late:staff", () => late.b))).unwrap();
    expect(owner.transports.list().map((t) => t.name)).toEqual(["loopback:owner", "late:owner"]);

    // the original goes away: whatever flows now can only be flowing over the late radio
    expect(await owner.transports.remove("loopback:owner", { drain: true })).toBe(true);
    expect(await staff.transports.remove("loopback:staff", { drain: true })).toBe(true);
    expect(await owner.transports.remove("loopback:owner")).toBe(false); // already gone
    expect(owner.transports.list().map((t) => t.name)).toEqual(["late:owner"]);
    // a route left, not data
    expect((await ho.db.select().from(notes)).map((r) => r.id)).toEqual(["first"]);

    await hs.db.insert(notes).values({ id: "second", body: "only the late radio is left" });
    for (let round = 0; round < 4; round += 1) await settle(late.control);
    expect((await ho.db.select().from(notes)).map((r) => r.id).sort()).toEqual(["first", "second"]);

    await owner.stop();
    await staff.stop();
  });
});

describe("start() symmetric with stop() (E24)", () => {
  test("a mesh created with start: false opens no link until start()", async () => {
    const { owner, staff, control } = await room({ start: false });
    expect(owner.running()).toBe(false);
    // ready() waits for start(), rather than answering for links nobody has opened
    let readied = false;
    void owner.ready().then(() => void (readied = true));

    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "early", body: "written before any link" });
    await settle(control);
    const ho = owner.on("org:acme").unwrap();
    expect(await ho.db.select().from(notes)).toHaveLength(0);
    expect(readied).toBe(false);

    owner.start().unwrap();
    staff.start().unwrap();
    expect(owner.running()).toBe(true);
    await Promise.all([owner.ready(), staff.ready()]);
    expect(readied).toBe(true);
    await settle(control);
    // the write made before the link existed crosses once there is one
    expect((await ho.db.select().from(notes)).map((r) => r.id)).toEqual(["early"]);

    await hs.db.insert(notes).values({ id: "late", body: "written over the open link" });
    await settle(control);
    expect((await ho.db.select().from(notes)).map((r) => r.id).sort()).toEqual(["early", "late"]);
    await owner.stop();
    await staff.stop();
  });

  test("start() is idempotent, on a deferred mesh and on an eager one", async () => {
    const { owner, staff, control } = await room({ start: false });
    expect(owner.start().isOk()).toBe(true);
    expect(owner.start().isOk()).toBe(true); // the second call opens nothing more
    expect(staff.start().isOk()).toBe(true);
    await Promise.all([owner.ready(), staff.ready()]);
    await settle(control);
    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "n1", body: "once" });
    await settle(control);
    const ho = owner.on("org:acme").unwrap();
    expect((await ho.db.select().from(notes)).map((r) => r.id)).toEqual(["n1"]);
    await owner.stop();
    await staff.stop();

    const eager = await room();
    expect(eager.owner.running()).toBe(true);
    expect(eager.owner.start().isOk()).toBe(true);
    expect(eager.owner.transports.list().map((t) => t.name)).toEqual(["loopback:owner"]);
    await eager.owner.stop();
    await eager.staff.stop();
  });

  test("start() after stop() is MeshStopped, as a value", async () => {
    const { owner, staff } = await room({ start: false });
    await owner.stop(); // stopped before it ever started: nothing was opened, nothing to close
    await owner.ready(); // and ready() does not wait for a start that can never come
    const again = owner.start();
    expect(again.isErr() && MeshStopped.is(again.error)).toBe(true);
    expect(owner.running()).toBe(false);

    staff.start().unwrap();
    await staff.stop();
    const restarted = staff.start();
    expect(restarted.isErr() && MeshStopped.is(restarted.error)).toBe(true);
  });

  test("transports.add before start() queues the medium to open with the rest", async () => {
    const { owner, staff } = await room({ start: false });
    const late = loopbackPair();
    const added = await owner.transports.add(linkTransport("late:owner", () => late.a));
    expect(added.isOk()).toBe(true);
    (await staff.transports.add(linkTransport("late:staff", () => late.b))).unwrap();
    expect(owner.transports.list().map((t) => t.name)).toEqual(["loopback:owner", "late:owner"]);
    // removing a medium that never opened is a set edit, and the original pair goes with it
    expect(await owner.transports.remove("loopback:owner")).toBe(true);
    expect(await staff.transports.remove("loopback:staff")).toBe(true);

    owner.start().unwrap();
    staff.start().unwrap();
    await Promise.all([owner.ready(), staff.ready()]);
    for (let round = 0; round < 4; round += 1) await settle(late.control);
    const hs = staff.on("org:acme").unwrap();
    await hs.db.insert(notes).values({ id: "queued", body: "over the queued radio" });
    for (let round = 0; round < 4; round += 1) await settle(late.control);
    const ho = owner.on("org:acme").unwrap();
    expect((await ho.db.select().from(notes)).map((r) => r.id)).toEqual(["queued"]);
    await owner.stop();
    await staff.stop();
  });
});
