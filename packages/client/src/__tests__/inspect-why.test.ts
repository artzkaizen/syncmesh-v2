import { createLink } from "@syncmesh/engine";
import { role } from "@syncmesh/policy";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, type Identity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("admin", "member") });
/** `deleteBy` is who this build lets delete: two builds that disagree are how a peer parks a write. */
const schema = (deleteBy: "admin" | "member") =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role: r }) => ({ $default: r("member"), delete: r(deleteBy) }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const deviceA = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const deviceB = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const open = async (device: Identity, deleteBy: "admin" | "member") => {
  const mesh = (
    await createMesh({
      schema: schema(deleteBy),
      identity: device,
      now: () => T0,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      trust: { issuer: issuer.peerId },
    })
  ).unwrap();
  for (const [who, account] of [
    [deviceA, "acct_a"],
    [deviceB, "acct_b"],
  ] as const)
    mesh.grants
      .register(
        issueGrant(issuer, {
          account,
          device: who.peerId,
          role: "member",
          // SAFETY: test fixture instances in the documented kind:id form
          partitions: ["org:acme"] as never,
          validFor: Temporal.Duration.from({ hours: 1 }),
          now: T0,
        }),
      )
      .unwrap();
  return mesh;
};

describe("mesh.inspect.why — the verdict with its reasons (U2)", () => {
  test("names the rung, the rule and its source, and the leaf that failed; the verdict is can's", async () => {
    const mesh = await open(deviceA, "admin");
    expect(mesh.inspect.why("notes.delete", undefined, "org:acme")).toEqual({
      allowed: false,
      rung: "policy",
      rule: { op: "delete", entry: "delete", source: "manifest" },
      because: [{ node: role("admin"), path: [], held: false }],
    });
    expect(mesh.inspect.why("notes.insert", undefined, "org:acme")).toMatchObject({
      allowed: true,
      rule: { entry: "$default" },
    });
    expect(mesh.inspect.why("ghosts.insert")).toEqual({ allowed: false, rung: "table" });
    for (const what of ["notes.insert", "notes.delete", "notes.read", "ghosts.read"] as const)
      expect(mesh.inspect.why(what, undefined, "org:acme").allowed).toBe(
        mesh.can(what, undefined, "org:acme"),
      );
    await mesh.stop();
  });

  test("a peer's write parked by policy reads back in $recovery with its rule and the leaf", async () => {
    const a = await open(deviceA, "admin");
    const b = await open(deviceB, "member"); // B's build lets a member delete; A's does not
    const handle = b.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "hello" });
    await handle.db.delete(notes).where(eq(notes.id, "n1"));

    const link = createLink(b.engine, a.engine, { now: () => T0 });
    (await link.catchUp()).unwrap();

    const [issue] = a.recovery.list();
    expect(issue?.verdict).toBe("PolicyDenied");
    expect(issue?.policy).toEqual({
      rule: { op: "delete", entry: "delete", source: "manifest" },
      because: [{ node: role("admin"), path: [], held: false }],
    });
    expect(issue?.message).toBe(
      'delete on notes denied by the delete rule (manifest): role("admin")',
    );
    const plan = issue === undefined ? undefined : a.recovery.explain(issue.event);
    expect(plan?.next).toContain(
      'The delete rule for delete in the bundled manifest refused it: role("admin")',
    );
    link.close();
    await a.stop();
    await b.stop();
  });
});

describe("mesh.inspect.telemetry — the tap (U2)", () => {
  test("counts what the mesh reports while open, holds one seat, and gives it back on close", async () => {
    const mesh = await open(deviceA, "admin");
    const before = mesh.inspect.handles().subscriptions;
    const tap = mesh.inspect.telemetry();
    expect(mesh.inspect.handles().subscriptions).toBe(before + 1);

    const handle = mesh.on("org:acme").unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "one" });
    await handle.db.insert(notes).values({ id: "n2", body: "two" });
    expect(tap.of("engine.mutate")?.count).toBe(2);
    expect(tap.of("engine.mutate")?.totals.get("changes")).toBe(2);
    expect(tap.report()).toContain("engine.mutate ×2");

    tap.reset();
    expect(tap.stats()).toEqual([]);
    tap.close();
    tap.close(); // a second close is a no-op, and gives back nothing it does not hold
    expect(mesh.inspect.handles().subscriptions).toBe(before);
    await handle.db.insert(notes).values({ id: "n3", body: "three" });
    expect(tap.stats()).toEqual([]); // closed: nothing more is counted
    {
      using scoped = mesh.inspect.telemetry();
      expect(mesh.inspect.handles().subscriptions).toBe(before + 1);
      expect(scoped.stats()).toEqual([]);
    }
    expect(mesh.inspect.handles().subscriptions).toBe(before);
    await mesh.stop();
  });
});
