import type { SyncEvent } from "@syncmesh/kernel";

import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

const todos = sqliteTable("todos", {
  id: text().primaryKey(),
  title: text().notNull(),
  score: integer().notNull(),
});
const schema = () =>
  syncSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      todos: {
        columns: {
          id: t.text().primaryKey(),
          title: t.text(),
          score: t.integer({ merge: "max" }),
        },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const granted = async (device: typeof deviceA, at: () => Temporal.Instant) => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      now: at,
    })
  ).unwrap();
  for (const [d, acct] of [
    [deviceA, "acct_a"],
    [deviceB, "acct_b"],
  ] as const) {
    mesh.grants
      .register(
        issueGrant(issuer, {
          account: acct,
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

describe("history — a row's timeline", () => {
  test("insert, update, delete: oldest first, per-write patches, snapshots, null once deleted", async () => {
    const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
    const device = deviceA;
    const mesh = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: syncSchema({
          tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } }, // global
        }),
        identity: device,
        authority: device.peerId,
        now: () => T0,
      })
    ).unwrap();
    const { db } = mesh.on().unwrap();
    await db.insert(notes).values({ id: "d1", body: "one" });
    await db.update(notes).set({ body: "two" }).where(eq(notes.id, "d1"));
    await db.delete(notes).where(eq(notes.id, "d1"));

    const revisions = (await mesh.history("notes", "d1")).unwrap();
    expect(revisions.map((r) => r.kind)).toEqual(["insert", "update", "delete"]);
    expect(revisions.map((r) => r.procedure)).toEqual([
      "notes.insert",
      "notes.update",
      "notes.delete",
    ]);
    expect(revisions[0]?.changed).toEqual({ id: "d1", body: "one" });
    expect(revisions[1]?.changed).toEqual({ body: "two" });
    expect(revisions[2]?.changed).toEqual({});
    expect(revisions.map((r) => r.row?.body ?? null)).toEqual(["one", "two", null]);
    expect(revisions[0]?.at.epochMilliseconds).toBe(T0.epochMilliseconds);
    // an ungranted local write has a device but no account
    expect(revisions[0]?.by).toBeUndefined();
    expect(String(revisions[0]?.peerId)).toBe(String(device.peerId));
    expect((await mesh.history("notes", "nope")).unwrap()).toEqual([]);
  });

  test("by is the account resolved through grants", async () => {
    const mesh = await granted(deviceA, () => T0);
    const { db } = mesh.on("org:acme").unwrap();
    await db.insert(todos).values({ id: "t1", title: "x", score: 1 });
    const revisions = (await mesh.history("todos", "t1")).unwrap();
    expect(revisions.map((r) => r.by)).toEqual(["acct_a"]);
  });

  test("two peers that merged offline edits compute the identical sequence, ordered by stamp not arrival", async () => {
    const a = await granted(deviceA, () => T0);
    const b = await granted(deviceB, () =>
      Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + 5_000),
    );
    const outA: SyncEvent[] = [];
    const outB: SyncEvent[] = [];
    a.engine.onOutbound((e) => void outA.push(e));
    b.engine.onOutbound((e) => void outB.push(e));
    const exchange = async () => {
      (await b.engine.receiveBatch(outA.map((event) => ({ event })))).unwrap();
      (await a.engine.receiveBatch(outB.map((event) => ({ event })))).unwrap();
    };
    const dbA = a.on("org:acme").unwrap().db;
    const dbB = b.on("org:acme").unwrap().db;

    await dbA.insert(todos).values({ id: "t1", title: "first", score: 1 });
    await exchange();
    // B writes the high score at its later clock; A then writes a LOWER score at a
    // later stamp still (its HLC ratcheted past B's on receive). max keeps 9.
    await dbB.update(todos).set({ score: 9 }).where(eq(todos.id, "t1"));
    await exchange();
    await dbA.update(todos).set({ title: "second", score: 3 }).where(eq(todos.id, "t1"));
    await exchange();

    const historyA = (await a.history("todos", "t1")).unwrap();
    const historyB = (await b.history("todos", "t1")).unwrap();
    expect(historyA.map((r) => String(r.eventId))).toEqual(historyB.map((r) => String(r.eventId)));
    expect(historyA.map((r) => r.by)).toEqual(["acct_a", "acct_b", "acct_a"]);

    // each revision's row is the kernel's fold up to its stamp, not a naive replay:
    // the last write set score 3, but the max column keeps 9 — on both peers
    const last = historyA.at(-1);
    expect(last?.changed).toEqual({ title: "second", score: 3 });
    expect(last?.row?.score).toBe(9);
    expect(last?.row?.title).toBe("second");
    expect(historyB.at(-1)?.row).toEqual(last?.row ?? null);

    // what the current value overwrote
    expect(historyA.at(-2)?.row?.title).toBe("first");
  });
});
