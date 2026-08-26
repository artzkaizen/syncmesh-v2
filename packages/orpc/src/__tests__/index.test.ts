import { ORPCError, call } from "@orpc/server";
import { createMesh } from "@syncmesh/client";
import { createMemoryEventStore } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { withMesh, type Caller } from "../index.js";

/** The only permission model: viewers read, techs read and own their rows, dispatchers assign. */
const schema = defineSchema({
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
  const store = createMemoryEventStore();
  const mesh = (
    await createMesh({ store, schema, identity: serverKey, issuer: issuer.peerId, now: () => T0 })
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
  return { mesh, store };
};

const caller = (role: string | undefined, org = "acme"): Caller =>
  role === undefined
    ? { account: "acct_nobody", pins: { org } }
    : { account: `acct_${role}`, role, pins: { org } };

/** D10's procedure: reject before tx, or one labelled event — no role check of its own. */
const api = async () => {
  const { mesh, store } = await authority();
  const assign = withMesh(mesh)
    .input(z.object({ id: z.string(), tech: z.string() }))
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .handler(async ({ input, context: { mesh: view, caller: who }, errors }) => {
      if (view.jobs.get(input.id) === undefined) throw errors.NOT_FOUND();
      if (view.jobs.list({ where: { assignee: input.tech, status: "assigned" } }).length > 0)
        throw errors.CONFLICT();
      const written = await view.tx(
        (c) =>
          c.jobs
            .update(input.id, { assignee: input.tech, status: "assigned", assignedBy: who.account })
            .map(() => undefined),
        { label: "jobs.assign" },
      );
      if (written.isErr())
        throw written.error._tag === "PolicyDenied" ? errors.FORBIDDEN() : written.error;
      return { eventId: String(written.value.eventId) };
    });
  const seeded = mesh.scoped({ org: "acme" }).unwrap();
  (await seeded.jobs.create({ id: "j1", title: "panel B", status: "open" })).unwrap();
  (await seeded.jobs.create({ id: "j2", title: "panel C", status: "open" })).unwrap();
  return { mesh, store, assign };
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

describe("a procedure acting as the caller", () => {
  test("a dispatcher's call writes one labelled event, the server's event, attributed to the dispatcher in data", async () => {
    const { mesh, store, assign } = await api();
    const before = (await store.all()).unwrap().length;
    const out = await assignAs(assign, caller("dispatcher"));
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    expect(acme.jobs.get("j1")).toMatchObject({
      status: "assigned",
      assignee: "acct_tech",
      assignedBy: "acct_dispatcher",
    });
    const last = (await acme.jobs.history("j1")).unwrap().at(-1);
    expect(last?.procedure).toBe("jobs.assign");
    expect(String(last?.eventId)).toBe(out.eventId);
    expect(String(last?.peerId)).toBe(String(serverKey.peerId));
    expect((await store.all()).unwrap().length).toBe(before + 1);
  });

  test("the schema decides: a viewer reads but may not update, a tech neither, nobody sees nothing", async () => {
    const { mesh, store, assign } = await api();
    const before = (await store.all()).unwrap().length;
    expect(await code(() => assignAs(assign, caller("viewer")))).toBe("FORBIDDEN");
    expect(await code(() => assignAs(assign, caller("tech")))).toBe("FORBIDDEN");
    expect(await code(() => assignAs(assign, caller(undefined)))).toBe("NOT_FOUND");
    expect(
      mesh
        .scoped({ org: "acme" }, { as: caller(undefined) })
        .unwrap()
        .jobs.list(),
    ).toEqual([]);
    expect(
      mesh
        .scoped({ org: "acme" }, { as: caller("viewer") })
        .unwrap()
        .jobs.list(),
    ).toHaveLength(2);
    expect((await store.all()).unwrap().length).toBe(before);
    expect(await code(() => assignAs(assign, caller("owner")))).toBe("ok");
  });

  test("a rejection the handler decides is thrown before tx: nothing is written", async () => {
    const { mesh, store, assign } = await api();
    await assignAs(assign, caller("dispatcher"), "j1");
    const before = (await store.all()).unwrap().length;
    expect(await code(() => assignAs(assign, caller("dispatcher"), "nope"))).toBe("NOT_FOUND");
    expect(await code(() => assignAs(assign, caller("dispatcher"), "j2"))).toBe("CONFLICT");
    expect((await store.all()).unwrap().length).toBe(before);
    expect(mesh.scoped({ org: "acme" }).unwrap().jobs.get("j2")?.status).toBe("open");
  });

  test("the caller's pins scope every read and write; a pin the manifest cannot resolve is BAD_REQUEST", async () => {
    const { assign } = await api();
    expect(await code(() => assignAs(assign, caller("dispatcher", "globex")))).toBe("NOT_FOUND");
    expect(await code(() => assignAs(assign, caller("dispatcher", "not a key")))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await code(() => assignAs(assign, { account: "a", role: "owner", pins: { site: "s1" } })),
    ).toBe("BAD_REQUEST");
  });
});
