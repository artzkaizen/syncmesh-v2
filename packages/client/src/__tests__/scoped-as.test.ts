import { createMemoryEventStore } from "@syncmesh/engine";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["owner", "dispatcher", "tech", "viewer"] },
    tables: {
      jobs: {
        columns: { id: t.text().primaryKey(), title: t.text(), assignee: t.text().nullable() },
        partition: "org",
        allow: ({ role, owner, anyOf }) => ({
          $default: role("tech"),
          read: role("viewer"),
          update: anyOf(role("dispatcher"), owner("assignee")),
          delete: role("owner"),
        }),
      },
      caps: { columns: { item: t.text().primaryKey(), max: t.integer() } },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const server = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const tag = <E extends { _tag: string }>(r: { isErr: () => boolean; error?: E }) =>
  // SAFETY: test helper; error is present exactly when isErr()
  r.isErr() ? (r as { error: E }).error._tag : "ok";

const authority = async () => {
  const mesh = (
    await createMesh({
      store: createMemoryEventStore(),
      schema: schema(),
      identity: server,
      issuer: issuer.peerId,
      authority: server.peerId,
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_server",
        device: server.peerId,
        role: "owner",
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: ["org:acme"] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  const own = mesh.scoped({ org: "acme" }).unwrap();
  (await own.jobs.create({ id: "j1", title: "one", assignee: "acct_t1" })).unwrap();
  (await own.jobs.create({ id: "j2", title: "two" })).unwrap();
  (await mesh.caps.create({ item: "widget", max: 10 })).unwrap();
  return mesh;
};

describe("scoped({ as }) — the schema's rules, for someone other than the device", () => {
  test("reads: a viewer sees the rows, an unknown role sees none, a table with no rules is open to all", async () => {
    const mesh = await authority();
    const viewer = mesh.scoped({ org: "acme" }, { as: { account: "v", role: "viewer" } }).unwrap();
    const nobody = mesh.scoped({ org: "acme" }, { as: { account: "n" } }).unwrap();
    expect(viewer.jobs.list().map((r) => r.id)).toEqual(["j1", "j2"]);
    expect(viewer.jobs.get("j1")?.title).toBe("one");
    expect(nobody.jobs.list()).toEqual([]);
    expect(nobody.jobs.get("j1")).toBeUndefined();
    expect(nobody.caps.list()).toHaveLength(1);
    expect(viewer.jobs.can("read")).toBe(true);
    expect(viewer.jobs.can("update", viewer.jobs.get("j1"))).toBe(false);
  });

  test("writes: denied before any event as PolicyDenied; allowed ones are still the device's events", async () => {
    const mesh = await authority();
    const before = (await mesh.engine.cursors()).unwrap().get(server.peerId);
    const viewer = mesh.scoped({ org: "acme" }, { as: { account: "v", role: "viewer" } }).unwrap();
    const owner = mesh
      .scoped({ org: "acme" }, { as: { account: "acct_t1", role: "tech" } })
      .unwrap();
    const dispatcher = mesh
      .scoped({ org: "acme" }, { as: { account: "d", role: "dispatcher" } })
      .unwrap();

    expect(tag(await viewer.jobs.update("j1", { title: "x" }))).toBe("PolicyDenied");
    expect(tag(await viewer.jobs.create({ id: "j3", title: "three" }))).toBe("PolicyDenied");
    expect(tag(await owner.jobs.update("j2", { title: "not mine" }))).toBe("PolicyDenied");
    expect(tag(await owner.jobs.update("j1", { title: "mine" }))).toBe("ok"); // owner("assignee")
    expect(tag(await dispatcher.jobs.delete("j1"))).toBe("PolicyDenied"); // delete: owner only
    expect((await dispatcher.jobs.update("j2", { assignee: "acct_t2" })).unwrap().assignee).toBe(
      "acct_t2",
    );
    const after = (await mesh.engine.cursors()).unwrap().get(server.peerId);
    expect(Number(after) - Number(before)).toBe(2);
    const last = (await dispatcher.jobs.history("j2")).unwrap().at(-1);
    expect(String(last?.peerId)).toBe(String(server.peerId));
  });

  test("an unreadable row is absent to writes too, and a different actor is a different view", async () => {
    const mesh = await authority();
    const nobody = mesh.scoped({ org: "acme" }, { as: { account: "n" } }).unwrap();
    expect(tag(await nobody.jobs.update("j1", { title: "x" }))).toBe("NoSuchRow");
    const a = mesh.scoped({ org: "acme" }, { as: { account: "v", role: "viewer" } }).unwrap();
    const b = mesh.scoped({ org: "acme" }, { as: { account: "n" } }).unwrap();
    const qa = mesh.liveQuery(a.jobs.query());
    const qb = mesh.liveQuery(b.jobs.query());
    expect(mesh.openQueries()).toBe(2);
    expect([qa.data().length, qb.data().length]).toEqual([2, 0]);
    mesh.releaseQuery(qa);
    mesh.releaseQuery(qb);
  });
});
