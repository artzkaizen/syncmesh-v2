import type { SyncEvent } from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      todos: {
        columns: {
          id: t.text().primaryKey(),
          title: t.text(),
          score: t.integer().onConflict("max"),
        },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
      drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const granted = async (device: typeof deviceA, at: () => Temporal.Instant) => {
  const mesh = (
    await createMesh({
      store: createMemoryEventStore(),
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
  mesh.activate("org:acme").unwrap();
  return mesh;
};

describe("history — a row's timeline", () => {
  test("insert, update, delete: oldest first, per-write patches, snapshots, null once deleted", async () => {
    const mesh = (
      await createMesh({
        store: createMemoryEventStore(),
        schema: schema(),
        identity: deviceA,
        now: () => T0,
      })
    ).unwrap();
    (await mesh.drafts.create({ id: "d1", body: "one" })).unwrap();
    (await mesh.drafts.update("d1", { body: "two" })).unwrap();
    (await mesh.drafts.delete("d1")).unwrap();

    const revisions = (await mesh.drafts.history("d1")).unwrap();
    expect(revisions.map((r) => r.kind)).toEqual(["insert", "update", "delete"]);
    expect(revisions.map((r) => r.procedure)).toEqual([
      "drafts.insert",
      "drafts.update",
      "drafts.delete",
    ]);
    expect(revisions[0]?.changed).toEqual({ id: "d1", body: "one" });
    expect(revisions[1]?.changed).toEqual({ body: "two" });
    expect(revisions[2]?.changed).toEqual({});
    expect(revisions.map((r) => r.row?.body ?? null)).toEqual(["one", "two", null]);
    expect(revisions[0]?.at.epochMilliseconds).toBe(T0.epochMilliseconds);
    // an ungranted local write has a device but no account
    expect(revisions[0]?.by).toBeUndefined();
    expect(String(revisions[0]?.peerId)).toBe(String(deviceA.peerId));
    expect((await mesh.drafts.history("nope")).unwrap()).toEqual([]);
  });

  test("by is the account resolved through grants", async () => {
    const mesh = await granted(deviceA, () => T0);
    (await mesh.todos.create({ id: "t1", title: "x", score: 1 })).unwrap();
    const revisions = (await mesh.todos.history("t1")).unwrap();
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

    (await a.todos.create({ id: "t1", title: "first", score: 1 })).unwrap();
    await exchange();
    // B writes the high score at its later clock; A then writes a LOWER score at a
    // later stamp still (its HLC ratcheted past B's on receive). max keeps 9.
    (await b.todos.update("t1", { score: 9 })).unwrap();
    await exchange();
    (await a.todos.update("t1", { title: "second", score: 3 })).unwrap();
    await exchange();

    const historyA = (await a.todos.history("t1")).unwrap();
    const historyB = (await b.todos.history("t1")).unwrap();
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
