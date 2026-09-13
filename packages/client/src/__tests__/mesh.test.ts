import type { SyncEvent } from "@syncmesh/kernel";

import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { createMesh } from "../mesh.js";

/** The tag the capture threw, under Drizzle's one wrapper — the same unwrap `withMesh` does. */
const tagOf = (thrown: Error): string | undefined => {
  // SAFETY: reading an optional discriminant off an Error — absent on a plain one, which is
  // what `undefined` here means
  const tagged = (thrown.cause instanceof Error ? thrown.cause : thrown) as { _tag?: string };
  return tagged._tag;
};

const catalog = sqliteTable("catalog", {
  id: text().primaryKey(),
  code: text().notNull(),
  stock: integer().notNull(),
});
const books = sqliteTable("books", {
  id: text().primaryKey(),
  title: text().notNull(),
  createdBy: text().notNull(),
});
const drafts = sqliteTable("drafts", { id: text().primaryKey(), body: text().notNull() });

const schema = () =>
  syncSchema({
    partitions: { org: {} },
    roles: { org: ["admin", "member"] },
    tables: {
      catalog: {
        columns: { id: t.text().primaryKey(), code: t.text(), stock: t.integer() },
      },
      books: {
        columns: { id: t.text().primaryKey(), title: t.text(), createdBy: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member"), delete: role("admin") }),
      },
      drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
    },
  });

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const open = async () =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      issuer: issuer.peerId,
      now: () => T0,
    })
  ).unwrap();

const granted = async (role = "member") => {
  const mesh = await open();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_a",
        device: device.peerId,
        role,
        // SAFETY: test fixture instances in the documented kind:id form
        partitions: ["org:acme"] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

/** The mesh's tag inside a rejected Drizzle write, or how the write actually ended. */
const outcome = (write: Promise<unknown>) =>
  write.then(
    () => "ok",
    (cause: unknown) => (cause instanceof Error ? (tagOf(cause) ?? String(cause)) : String(cause)),
  );

describe("on — one handle per pin and principal", () => {
  test("a malformed pin is refused; the same pin returns the same handle", async () => {
    const mesh = await granted();
    const bad = mesh.on("not a key");
    expect(bad.isErr() && bad.error._tag).toBe("InvalidPartitionKey");
    const first = mesh.on("org:acme").unwrap();
    expect(mesh.on("org:acme").unwrap()).toBe(first);
    expect(mesh.on()).not.toBe(first);
  });
});

describe("the schema judges every write, wherever it entered", () => {
  test("the ladder answers in order: global is read-only, org tables need a grant, then columns", async () => {
    // no issuer: the mesh trusts no root yet, so nothing is granted
    const mesh = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: device,
        now: () => T0,
      })
    ).unwrap();
    const global = mesh.on().unwrap().db;
    expect(await outcome(global.insert(catalog).values({ id: "c1", code: "x", stock: 1 }))).toBe(
      "ReadOnlyPartition",
    );
    // with an issuer configured but no grant held, the grant rung refuses first
    const gated = await open();
    const { db } = gated.on("org:acme").unwrap();
    expect(await outcome(db.insert(books).values({ id: "b1", title: "x", createdBy: "a" }))).toBe(
      "NoGrant",
    );
    // the app table holds nothing: the refused statements were rolled back with their events
    expect(await global.select().from(catalog)).toHaveLength(0);

    // as the authority the partition rung passes, and the column check gets its turn
    const authority = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: device,
        authority: device.peerId,
        now: () => T0,
      })
    ).unwrap();
    const adb = authority.on().unwrap().db;
    // a fractional stock survives SQLite's affinity and the integer column refuses it
    expect(await outcome(adb.insert(catalog).values({ id: "c1", code: "x", stock: 1.5 }))).toBe(
      "SchemaViolation",
    );
    await adb.insert(catalog).values({ id: "c1", code: "x", stock: 3 });
    expect(await adb.select().from(catalog)).toHaveLength(1);
  });

  test("a member writes but cannot delete; an admin can — the same rules can() answers from", async () => {
    const member = await granted();
    const { db } = member.on("org:acme").unwrap();
    await db.insert(books).values({ id: "b1", title: "Dune", createdBy: "acct_a" });
    expect(await outcome(db.delete(books).where(eq(books.id, "b1")))).toBe("PolicyDenied");
    expect((await db.select().from(books)).map((r) => r.title)).toEqual(["Dune"]);
    expect(member.can("books.insert")).toBe(true);
    expect(member.can("books.delete")).toBe(false);

    const admin = await granted("admin");
    const ha = admin.on("org:acme").unwrap();
    await ha.db.insert(books).values({ id: "b1", title: "Dune", createdBy: "acct_a" });
    await ha.db.delete(books).where(eq(books.id, "b1"));
    expect(await ha.db.select().from(books)).toHaveLength(0);
    expect(admin.can("books.delete")).toBe(true);
  });
});

describe("statements become events", () => {
  test("the pin stamps the partition; a no-op update makes no event", async () => {
    const mesh = await granted();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    const { db } = mesh.on("org:acme").unwrap();
    await db.insert(books).values({ id: "b1", title: "Dune", createdBy: "acct_a" });
    expect(String(events.at(-1)?.partition)).toBe("org:acme");
    expect(String(events.at(-1)?.procedure)).toBe("books.insert");

    await db.update(books).set({ title: "Dune" }).where(eq(books.id, "b1"));
    expect(events).toHaveLength(1); // nothing changed — nothing to say
  });

  test("a transaction lands as one event with a derived label and only the changed cells", async () => {
    const mesh = await granted();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    const { db } = mesh.on("org:acme").unwrap();
    await db.insert(books).values({ id: "b1", title: "old", createdBy: "acct_a" });
    await db.transaction(async (tx) => {
      await tx.insert(books).values({ id: "b2", title: "new", createdBy: "acct_a" });
      await tx.update(books).set({ title: "renamed" }).where(eq(books.id, "b1"));
    });
    expect(events).toHaveLength(2);
    expect(String(events.at(-1)?.procedure)).toBe("books.insert+books.update");
    expect(events.at(-1)?.changes).toHaveLength(2);
    const patch = events.at(-1)?.changes.find((c) => c.kind === "update");
    expect(patch?.kind === "update" && [...patch.patch.keys()].map(String)).toEqual(["title"]);
    expect((await db.select().from(books).orderBy(books.id)).map((r) => r.title)).toEqual([
      "renamed",
      "new",
    ]);
  });
});

describe("local tables", () => {
  test("rows stay on this device: no outbound event, and history still sees the write", async () => {
    const mesh = await granted();
    const events: SyncEvent[] = [];
    mesh.engine.onOutbound((e) => void events.push(e));
    const { db } = mesh.on().unwrap();
    await db.insert(drafts).values({ id: "d1", body: "wip" });
    expect(events).toHaveLength(0);
    expect((await db.select().from(drafts)).map((r) => r.body)).toEqual(["wip"]);
    const revisions = (await mesh.history("drafts", "d1")).unwrap();
    expect(revisions.map((r) => r.procedure)).toEqual(["drafts.insert"]);
  });

  test("one transaction cannot both travel and stay: mixing tables is LocalOnly, rolled back", async () => {
    const mesh = await granted();
    const { db } = mesh.on("org:acme").unwrap();
    expect(
      await outcome(
        db.transaction(async (tx) => {
          await tx.insert(books).values({ id: "b1", title: "x", createdBy: "acct_a" });
          await tx.insert(drafts).values({ id: "d1", body: "wip" });
        }),
      ),
    ).toBe("LocalOnly");
    expect(await db.select().from(books)).toHaveLength(0);
    expect(await db.select().from(drafts)).toHaveLength(0);
  });
});
