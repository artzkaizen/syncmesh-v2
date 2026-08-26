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
      jobs: {
        columns: { id: t.text().primaryKey(), title: t.text(), assignee: t.text().nullable() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const server = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const tag = <E extends { _tag: string }>(r: { isErr: () => boolean; error?: E }) =>
  // SAFETY: test helper; error is present exactly when isErr()
  r.isErr() ? (r as { error: E }).error._tag : "ok";

/** One process serving two tenants — the authority's shape. */
const twoTenants = async () => {
  const mesh = (
    await createMesh({
      store: createMemoryEventStore(),
      schema: schema(),
      identity: server,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_server",
        device: server.peerId,
        role: "member",
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: ["org:acme", "org:globex"] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

describe("scoped — a view pinned to instances, activate never involved", () => {
  test("two scopes write and read their own instance; the ambient view stays unset", async () => {
    const mesh = await twoTenants();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    const globex = mesh.scoped({ org: "globex" }).unwrap();

    // interleaved, as two concurrent requests would be
    await Promise.all([
      acme.jobs.create({ id: "a1", title: "acme one" }),
      globex.jobs.create({ id: "g1", title: "globex one" }),
      acme.jobs.create({ id: "a2", title: "acme two" }),
    ]);
    expect(acme.jobs.list().map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(globex.jobs.list().map((r) => r.id)).toEqual(["g1"]);
    expect(events.map((e) => String(e.partition))).toEqual(["org:acme", "org:globex", "org:acme"]);

    // the ambient view was never activated: it still refuses, and names the fix
    expect(mesh.active("org")).toBeUndefined();
    expect(tag(await mesh.jobs.create({ id: "x", title: "nowhere" }))).toBe("NoActivePartition");
    expect(acme.jobs.get("g1")).toBeUndefined();
  });

  test("tx under a scope lands in that instance and takes a label", async () => {
    const mesh = await twoTenants();
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    const receipt = (
      await acme.tx(
        (c) =>
          c.jobs
            .create({ id: "a1", title: "one", assignee: "tech7" })
            .andThen(() => c.jobs.create({ id: "a2", title: "two" }))
            .map(() => undefined),
        { label: "jobs.assign" },
      )
    ).unwrap();
    const revisions = (await acme.jobs.history("a1")).unwrap();
    expect(revisions.map((r) => r.procedure)).toEqual(["jobs.assign"]);
    expect(acme.jobs.list().map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(String(receipt.eventId).endsWith("-1")).toBe(true);
    expect(mesh.scoped({ org: "globex" }).unwrap().jobs.get("a1")).toBeUndefined();
  });

  test("the same pins are the same view: live results share within a scope, never across", async () => {
    const mesh = await twoTenants();
    const acme = mesh.scoped({ org: "acme" }).unwrap();
    const again = mesh.scoped({ org: "acme" }).unwrap();
    const globex = mesh.scoped({ org: "globex" }).unwrap();
    const a = mesh.liveQuery(acme.jobs.query({ orderBy: "title" }));
    const b = mesh.liveQuery(again.jobs.query({ orderBy: "title" }));
    const g = mesh.liveQuery(globex.jobs.query({ orderBy: "title" }));
    expect(mesh.openQueries()).toBe(2);
    let acmeNotified = 0;
    let globexNotified = 0;
    a.subscribe(() => void (acmeNotified += 1));
    g.subscribe(() => void (globexNotified += 1));
    (await globex.jobs.create({ id: "g1", title: "globex" })).unwrap();
    expect(g.data().map((r) => r.id)).toEqual(["g1"]);
    expect(a.data()).toEqual([]);
    expect([acmeNotified, globexNotified]).toEqual([0, 1]);
    for (const h of [a, b, g]) mesh.releaseQuery(h);
    expect(mesh.openQueries()).toBe(0);
  });

  test("a kind the manifest lacks, a bad id, and a kind the pins leave out are all values", async () => {
    const mesh = await twoTenants();
    expect(tag(mesh.scoped({ site: "s1" }))).toBe("UnknownPartitionKind");
    expect(tag(mesh.scoped({ org: "not a key" }))).toBe("InvalidPartitionKey");
    const unpinned = mesh.scoped({}).unwrap();
    const r = await unpinned.jobs.create({ id: "a1", title: "one" });
    expect(tag(r)).toBe("NoActivePartition");
    expect(r.isErr() && r.error.message).toContain("not pinned in this scope");
  });
});
