import type { SyncEvent } from "@syncmesh/kernel";

import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["admin", "member"] },
    tables: {
      catalog: { columns: { id: t.text().primaryKey(), code: t.text() } },
      books: {
        columns: {
          id: t.text().primaryKey(),
          title: t.text(),
          pinned: t.boolean().default(false),
          addedAt: t.timestamp().nullable(),
          createdBy: t.text(),
        },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member"), delete: role("admin") }),
      },
      notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "user" },
      drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const granted = (role = "member", partitions = ["org:acme"]) => {
  const mesh = createMesh({
    schema: schema(),
    identity: device,
    issuer: issuer.peerId,
    now: () => T0,
  });
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_a",
        device: device.peerId,
        role,
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: partitions as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

const tag = <E extends { _tag: string }>(r: { isErr: () => boolean; error?: E }) =>
  // SAFETY: test helper; error is present exactly when isErr()
  r.isErr() ? (r as { error: E }).error._tag : "ok";

describe("the namespace", () => {
  test("reserved tables never surface as collections; declared tables do", () => {
    const mesh = granted();
    expect("_policy" in mesh).toBe(false);
    expect("_corrections" in mesh).toBe(false);
    for (const name of ["catalog", "books", "notes", "drafts"]) expect(name in mesh).toBe(true);
  });
});

describe("verbs", () => {
  test("insert fills defaults, converts timestamps both ways, and reads back the stored row", async () => {
    const mesh = granted();
    mesh.activate("org:acme").unwrap();
    const stored = (
      await mesh.books.insert({ id: "b1", title: "Dune", addedAt: T0, createdBy: "acct_a" })
    ).unwrap();
    expect(stored.pinned).toBe(false);
    expect(stored.addedAt?.epochMilliseconds).toBe(T0.epochMilliseconds);
    expect(mesh.books.byId("b1")?.title).toBe("Dune");
    expect(mesh.books.all()).toHaveLength(1);
  });

  test("a wrong value is refused at the call site before any event exists", async () => {
    const mesh = granted();
    mesh.activate("org:acme").unwrap();
    // SAFETY: deliberately wrong value under test
    const r = await mesh.books.insert({ id: "b1", title: 3 as never, createdBy: "acct_a" });
    expect(tag(r)).toBe("ColumnCheckFailed");
    expect(mesh.books.all()).toHaveLength(0);
  });

  test("update writes only the columns that changed; an unchanged patch is EmptyMutation", async () => {
    const mesh = granted();
    mesh.activate("org:acme").unwrap();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    (await mesh.books.insert({ id: "b1", title: "Dune", createdBy: "acct_a" })).unwrap();
    const updated = (await mesh.books.update("b1", { title: "Dune II", pinned: false })).unwrap();
    expect(updated.title).toBe("Dune II");
    const patch = events.at(-1)?.changes[0];
    expect(patch?.kind === "update" && [...patch.patch.keys()].map(String)).toEqual(["title"]);
    expect(tag(await mesh.books.update("b1", { pinned: false }))).toBe("EmptyMutation");
    expect(tag(await mesh.books.update("nope", { title: "x" }))).toBe("NoSuchRow");
  });

  test("delete removes the row from every read", async () => {
    const mesh = granted("admin");
    mesh.activate("org:acme").unwrap();
    (await mesh.books.insert({ id: "b1", title: "Dune", createdBy: "acct_a" })).unwrap();
    (await mesh.books.delete("b1")).unwrap();
    expect(mesh.books.byId("b1")).toBeUndefined();
    expect(mesh.books.all()).toHaveLength(0);
  });
});

describe("placement", () => {
  test("an org table with nothing active names the setter; activate re-points; unknown kinds are refused", async () => {
    const mesh = granted("member", ["org:acme", "org:globex"]);
    const before = await mesh.books.insert({ id: "b1", title: "x", createdBy: "acct_a" });
    expect(tag(before)).toBe("NoActivePartition");
    expect(before.isErr() && before.error.message).toContain('activate("org:<id>")');

    mesh.activate("org:acme").unwrap();
    (await mesh.books.insert({ id: "b1", title: "acme", createdBy: "acct_a" })).unwrap();
    mesh.activate("org:globex").unwrap();
    (await mesh.books.insert({ id: "b2", title: "globex", createdBy: "acct_a" })).unwrap();
    expect(mesh.books.all().map((r) => r.title)).toEqual(["globex"]);

    expect(tag(mesh.activate("site:acme"))).toBe("UnknownPartitionKind");
    expect(tag(mesh.activate("not a key"))).toBe("InvalidPartitionKey");
  });

  test("one instance in the grant is implied — no activate call needed", async () => {
    const mesh = granted();
    (await mesh.books.insert({ id: "b1", title: "x", createdBy: "acct_a" })).unwrap();
    expect(String(mesh.active("org"))).toBe("org:acme");
  });

  test("user rows go to the account's partition; local rows never reach outbound", async () => {
    const mesh = granted();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    (await mesh.notes.insert({ id: "n1", body: "milk" })).unwrap();
    expect(String(events.at(-1)?.partition)).toBe("user:acct_a");
    (await mesh.drafts.insert({ id: "d1", body: "wip" })).unwrap();
    expect(events).toHaveLength(1);
    expect(mesh.drafts.all()).toHaveLength(1);
  });

  test("ungranted: schema still checks, global is read-only, user tables need a grant", async () => {
    const mesh = createMesh({ schema: schema(), identity: device, now: () => T0 });
    // SAFETY: deliberately wrong value under test
    expect(tag(await mesh.catalog.insert({ id: "c1", code: 3 as never }))).toBe(
      "ColumnCheckFailed",
    );
    expect(tag(await mesh.catalog.insert({ id: "c1", code: "x" }))).toBe("ReadOnlyPartition");
    expect(tag(await mesh.notes.insert({ id: "n1", body: "b" }))).toBe("NoGrant");
    (await mesh.drafts.insert({ id: "d1", body: "wip" })).unwrap();
  });
});

describe("tx", () => {
  test("tables of different partitions are refused before anything is written", async () => {
    const mesh = granted();
    mesh.activate("org:acme").unwrap();
    const r = await mesh.tx((c) =>
      c.books
        .insert({ id: "b1", title: "x", createdBy: "acct_a" })
        .andThen(() => c.notes.insert({ id: "n1", body: "b" }))
        .map(() => undefined),
    );
    expect(tag(r)).toBe("CrossPartitionTx");
    expect(mesh.books.all()).toHaveLength(0);
    expect(mesh.notes.all()).toHaveLength(0);
  });

  test("one partition lands as one event with a derived label", async () => {
    const mesh = granted();
    mesh.activate("org:acme").unwrap();
    (await mesh.books.insert({ id: "b1", title: "old", createdBy: "acct_a" })).unwrap();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    (
      await mesh.tx((c) =>
        c.books
          .insert({ id: "b2", title: "new", createdBy: "acct_a" })
          .andThen(() => c.books.update("b1", { title: "renamed" }))
          .map(() => undefined),
      )
    ).unwrap();
    expect(events).toHaveLength(1);
    expect(String(events[0]?.procedure)).toBe("books.insert+books.update");
    expect(events[0]?.changes).toHaveLength(2);
    expect(mesh.books.byId("b1")?.title).toBe("renamed");
  });
});

describe("can", () => {
  test("answers from the same rules the receivers enforce", () => {
    const member = granted();
    expect(member.can("books.insert")).toBe(true);
    expect(member.can("books.delete")).toBe(false);
    expect(member.books.can("delete")).toBe(false);
    expect(granted("admin").can("books.delete")).toBe(true);
  });
});
