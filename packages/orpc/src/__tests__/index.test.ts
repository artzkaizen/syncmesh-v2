import { ORPCError, call } from "@orpc/server";
import { createMesh } from "@syncmesh/client";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { withMesh, type Caller } from "../index.js";

const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  status: text().notNull(),
  assignee: text(),
  assignedBy: text(),
});

/** The only permission model: viewers read, techs read and own their rows, dispatchers assign. */
const schema = syncSchema({
  partitions: { org: {} },
  roles: { org: ["owner", "dispatcher", "tech", "viewer"] },
  tables: {
    jobs: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        status: t.text().check(z.enum(["open", "assigned"])),
        assignee: t.text().nullable(),
        assignedBy: t.text().nullable(),
      },
      partition: "org",
      allow: ({ role }) => ({
        $default: role("tech"),
        read: role("viewer"),
        update: role("dispatcher"),
      }),
    },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const serverKey = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** The authority: one process, one grant with the top role in every org it serves. */
const authority = async () => {
  const mesh = (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema,
      identity: serverKey,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_server",
        device: serverKey.peerId,
        role: "owner",
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: ["org:acme", "org:globex"] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

const caller = (role: string | undefined, org = "acme"): Caller =>
  role === undefined
    ? { account: "acct_nobody", partition: `org:${org}` }
    : { account: `acct_${role}`, role, partition: `org:${org}` };

/** D10's procedure: reject before the write, or one event — no role check of its own. */
const api = async () => {
  const mesh = await authority();
  const assign = withMesh(mesh)
    .input(z.object({ id: z.string(), tech: z.string() }))
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .handler(async ({ input, context: { mesh: view, caller: who }, errors }) => {
      const j = view.read(jobs);
      const [job] = await view.db.select().from(j).where(eq(j.id, input.id));
      if (job === undefined) throw errors.NOT_FOUND();
      const taken = await view.db
        .select()
        .from(j)
        .where(and(eq(j.assignee, input.tech), eq(j.status, "assigned")));
      if (taken.length > 0) throw errors.CONFLICT();
      await view.db
        .update(jobs)
        .set({ assignee: input.tech, status: "assigned", assignedBy: who.account })
        .where(eq(jobs.id, input.id));
      return { assigned: input.id };
    });
  const seeded = mesh.on("org:acme").unwrap();
  await seeded.db.insert(jobs).values({ id: "j1", title: "panel B", status: "open" });
  await seeded.db.insert(jobs).values({ id: "j2", title: "panel C", status: "open" });
  return { mesh, assign };
};

/** The defined error code a call throws, `"ok"` when it returns, `"thrown"` for anything else. */
const code = async <T>(run: () => Promise<T>): Promise<string> => {
  try {
    await run();
    return "ok";
  } catch (cause) {
    return cause instanceof ORPCError ? String(cause.code) : "thrown";
  }
};

const assignAs = (assign: Awaited<ReturnType<typeof api>>["assign"], who: Caller, id = "j1") =>
  call(assign, { id, tech: "acct_tech" }, { context: { caller: who } });

const eventCount = async (mesh: Awaited<ReturnType<typeof authority>>) =>
  (await mesh.engine.eventsSince(new Map())).unwrap().length;

describe("a procedure acting as the caller", () => {
  test("a dispatcher's call writes one event, the server's event, attributed to the dispatcher in data", async () => {
    const { mesh, assign } = await api();
    const before = await eventCount(mesh);
    await assignAs(assign, caller("dispatcher"));
    const acme = mesh.on("org:acme").unwrap();
    const [j1] = await acme.db.select().from(jobs).where(eq(jobs.id, "j1"));
    expect(j1).toMatchObject({
      status: "assigned",
      assignee: "acct_tech",
      assignedBy: "acct_dispatcher",
    });
    const last = (await mesh.history("jobs", "j1")).unwrap().at(-1);
    expect(last?.procedure).toBe("jobs.update");
    expect(String(last?.peerId)).toBe(String(serverKey.peerId));
    expect(await eventCount(mesh)).toBe(before + 1);
  });

  test("the schema decides: a viewer reads but may not update, a tech neither, nobody sees nothing", async () => {
    const { mesh, assign } = await api();
    const before = await eventCount(mesh);
    expect(await code(() => assignAs(assign, caller("viewer")))).toBe("FORBIDDEN");
    expect(await code(() => assignAs(assign, caller("tech")))).toBe("FORBIDDEN");
    expect(await code(() => assignAs(assign, caller(undefined)))).toBe("NOT_FOUND");
    const nobody = mesh.on("org:acme", { as: { account: "acct_nobody", claims: {} } }).unwrap();
    expect(await nobody.db.select().from(nobody.read(jobs))).toEqual([]);
    const viewer = mesh
      .on("org:acme", { as: { account: "acct_viewer", role: "viewer", claims: {} } })
      .unwrap();
    expect(await viewer.db.select().from(viewer.read(jobs))).toHaveLength(2);
    expect(await eventCount(mesh)).toBe(before);
    expect(await code(() => assignAs(assign, caller("owner")))).toBe("ok");
  });

  test("a rejection the handler decides is thrown before the write: nothing lands", async () => {
    const { mesh, assign } = await api();
    await assignAs(assign, caller("dispatcher"), "j1");
    const before = await eventCount(mesh);
    expect(await code(() => assignAs(assign, caller("dispatcher"), "nope"))).toBe("NOT_FOUND");
    expect(await code(() => assignAs(assign, caller("dispatcher"), "j2"))).toBe("CONFLICT");
    expect(await eventCount(mesh)).toBe(before);
    const acme = mesh.on("org:acme").unwrap();
    const [j2] = await acme.db.select().from(jobs).where(eq(jobs.id, "j2"));
    expect(j2?.status).toBe("open");
  });

  test("the caller's partition scopes every read; a pin the manifest cannot parse is BAD_REQUEST", async () => {
    const { assign } = await api();
    // j1 lives in org:acme — under org:globex the filtered read finds nothing
    expect(await code(() => assignAs(assign, caller("dispatcher", "globex")))).toBe("NOT_FOUND");
    expect(await code(() => assignAs(assign, caller("dispatcher", "not a key")))).toBe(
      "BAD_REQUEST",
    );
  });
});
