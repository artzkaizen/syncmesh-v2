import { createLink } from "@syncmesh/engine";
import { eventId } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

const todos = sqliteTable("todos", { id: text().primaryKey(), title: text().notNull() });
const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      todos: {
        columns: { id: t.text().primaryKey(), title: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const granted = async (device: typeof deviceA) => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();
  for (const [d, account] of [
    [deviceA, "acct_a"],
    [deviceB, "acct_b"],
  ] as const) {
    mesh.grants
      .register(
        issueGrant(issuer, {
          account,
          device: d.peerId,
          role: "member",
          // SAFETY: test fixture instances in the documented kind:id form
          partitions: ["org:acme"] as never,
          validFor: Temporal.Duration.from({ hours: 1 }),
          now: T0,
        }),
      )
      .unwrap();
  }
  return mesh;
};

const lastEvent = async (mesh: Awaited<ReturnType<typeof granted>>) => {
  const stored = (await mesh.engine.eventsSince(new Map())).unwrap();
  return stored.at(-1)?.event.id ?? panicMissing();
};
const panicMissing = () => {
  throw new Error("the mesh has no stored event");
};

describe("delivered — a peer is known to hold the write", () => {
  test("pending before the cursor exchange covers the write, resolved after, immediate once covered", async () => {
    const a = await granted(deviceA);
    const b = await granted(deviceB);
    await a.delivered(); // nothing synced yet — nothing to wait for

    const ha = a.on("org:acme").unwrap();
    await ha.db.insert(todos).values({ id: "t1", title: "x" });
    const pending = a.delivered({ to: deviceB.peerId });
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // no exchange yet

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await pending;
    const hb = b.on("org:acme").unwrap();
    expect(await hb.db.select().from(todos)).toHaveLength(1);
    // already covered: a fresh call resolves immediately, with or without a named peer
    await a.delivered();
    await a.delivered({ to: deviceB.peerId });
    link.close();
  });

  test("delivered({ event }) waits for exactly the transaction's event", async () => {
    const a = await granted(deviceA);
    const b = await granted(deviceB);
    const ha = a.on("org:acme").unwrap();
    await ha.db.transaction(async (tx) => {
      await tx.insert(todos).values({ id: "t1", title: "from tx" });
    });
    const pending = a.delivered({ event: await lastEvent(a), to: deviceB.peerId });
    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await pending;
    const hb = b.on("org:acme").unwrap();
    expect((await hb.db.select().from(todos)).map((r) => r.title)).toEqual(["from tx"]);
    link.close();
  });
});

describe("received — this device has folded a peer's event", () => {
  test("pending until the exchange folds it, resolved after, immediate once held; a local id is refused", async () => {
    const a = await granted(deviceA);
    const b = await granted(deviceB);
    const ha = a.on("org:acme").unwrap();
    await ha.db.insert(todos).values({ id: "t1", title: "from a" });
    const event = await lastEvent(a);

    const pending = b.received({ event });
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    const link = createLink(a.engine, b.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();
    await pending;
    await b.received({ event }); // already folded: resolves at once
    link.close();

    // SAFETY: forging a seqNum for a synthetic local id — the refusal is what's under test
    const local = eventId(deviceA.peerId, 1 as never, true);
    expect(() => b.received({ event: local })).toThrow("never leaves this device");
  });
});
