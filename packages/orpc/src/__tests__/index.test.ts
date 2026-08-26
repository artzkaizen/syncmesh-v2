import { ORPCError, call } from "@orpc/server";
import { createMesh } from "@syncmesh/client";
import { createMemoryEventStore } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { requireRole, withMesh, type Caller } from "../index.js";

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
      allow: ({ role }) => ({ $default: role("tech"), update: role("dispatcher") }),
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

const caller = (role: string, org = "acme"): Caller => ({
  account: `acct_${role}`,
  role,
  pins: { org },
});

/** The procedure D10 sketches, verbatim in shape: reject before tx, or one labelled event. */
const api = async () => {
  const { mesh, store } = await authority();
  const base = withMesh(mesh);
  const assign = base
    .use(requireRole(schema, "org", "dispatcher"))
    .input(z.object({ id: z.string(), tech: z.string() }))
    .errors({ NOT_FOUND: {}, CONFLICT: {} })
    .handler(async ({ input, context: { db, caller: who }, errors }) => {
      if (db.jobs.get(input.id) === undefined) throw errors.NOT_FOUND();
      if (db.jobs.list({ where: { assignee: input.tech, status: "assigned" } }).length > 0)
        throw errors.CONFLICT();
      const receipt = (
        await db.tx(
          (c) =>
            c.jobs
              .update(input.id, {
                assignee: input.tech,
                status: "assigned",
                assignedBy: who.account,
              })
              .map(() => undefined),
          { label: "jobs.assign" },
        )
      ).unwrap();
      return { eventId: String(receipt.eventId) };
    });
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

describe("a procedure over the authority's mesh", () => {
  test("writes one labelled event under the caller's instance, attributed to the caller in data", async () => {
    const { mesh, store, assign } = await api();
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    (await acme.jobs.create({ id: "j1", title: "panel B", status: "open" })).unwrap();
    const before = (await store.all()).unwrap().length;

    const out = await call(
      assign,
      { id: "j1", tech: "acct_tech" },
      { context: { caller: caller("dispatcher") } },
    );
    expect(acme.jobs.get("j1")).toMatchObject({
      status: "assigned",
      assignee: "acct_tech",
      assignedBy: "acct_dispatcher",
    });
    const revisions = (await acme.jobs.history("j1")).unwrap();
    expect(revisions.at(-1)?.procedure).toBe("jobs.assign");
    expect(String(revisions.at(-1)?.eventId)).toBe(out.eventId);
    expect((await store.all()).unwrap().length).toBe(before + 1);
  });

  test("a rejection is a typed error thrown before tx: nothing is written", async () => {
    const { mesh, store, assign } = await api();
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    (await acme.jobs.create({ id: "j1", title: "one", status: "open" })).unwrap();
    (await acme.jobs.create({ id: "j2", title: "two", status: "open" })).unwrap();
    await call(
      assign,
      { id: "j1", tech: "acct_tech" },
      { context: { caller: caller("dispatcher") } },
    );
    const before = (await store.all()).unwrap().length;

    expect(
      await code(() =>
        call(assign, { id: "nope", tech: "x" }, { context: { caller: caller("dispatcher") } }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(() =>
        call(
          assign,
          { id: "j2", tech: "acct_tech" },
          { context: { caller: caller("dispatcher") } },
        ),
      ),
    ).toBe("CONFLICT");
    expect((await store.all()).unwrap().length).toBe(before);
    expect(acme.jobs.get("j2")?.status).toBe("open");
  });

  test("requireRole is the schema's ladder: viewer and tech are FORBIDDEN, owner passes", async () => {
    const { mesh, assign } = await api();
    (
      await mesh
        .scoped({ org: "acme" })
        .unwrap()
        .jobs.create({ id: "j1", title: "one", status: "open" })
    ).unwrap();
    expect(
      await code(() =>
        call(assign, { id: "j1", tech: "t" }, { context: { caller: caller("viewer") } }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(() =>
        call(assign, { id: "j1", tech: "t" }, { context: { caller: caller("tech") } }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(() =>
        call(
          assign,
          { id: "j1", tech: "t" },
          { context: { caller: { account: "a", pins: { org: "acme" } } } },
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(() =>
        call(assign, { id: "j1", tech: "t" }, { context: { caller: caller("owner") } }),
      ),
    ).toBe("ok");
  });

  test("the caller's pins scope every read and write; a pin the manifest cannot resolve is BAD_REQUEST", async () => {
    const { mesh, assign } = await api();
    (
      await mesh
        .scoped({ org: "acme" })
        .unwrap()
        .jobs.create({ id: "j1", title: "one", status: "open" })
    ).unwrap();
    expect(
      await code(() =>
        call(
          assign,
          { id: "j1", tech: "t" },
          { context: { caller: caller("dispatcher", "globex") } },
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(() =>
        call(
          assign,
          { id: "j1", tech: "t" },
          { context: { caller: caller("dispatcher", "not a key") } },
        ),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await code(() =>
        call(
          assign,
          { id: "j1", tech: "t" },
          { context: { caller: { account: "a", role: "owner", pins: { site: "s1" } } } },
        ),
      ),
    ).toBe("BAD_REQUEST");
  });
});
