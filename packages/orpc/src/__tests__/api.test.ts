import { createMesh } from "@syncmesh/client";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { local, meshApi } from "../api.js";

const book = sqliteTable("book", {
  id: text().primaryKey(),
  title: text().notNull(),
  shelf: text(),
});

const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["owner", "member", "viewer"] },
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text(), shelf: t.text().nullable() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member"), read: role("viewer") }),
    },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 70 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = "org:acme";

/** The one surface an app touches: a read that has not run, and a write that is one event. */
const books = {
  list: local.query
    .input(z.object({ shelf: z.string().optional() }))
    .handler(({ input, mesh }) =>
      input.shelf === undefined
        ? mesh.db.select().from(book)
        : mesh.db.select().from(book).where(eq(book.shelf, input.shelf)),
    ),

  create: local.mutation
    .input(z.object({ id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, mesh }) => {
      await mesh.db.insert(book).values({ id: input.id, title: input.title });
      return { id: input.id };
    }),
};

const open = async (role: string | undefined) => {
  const mesh = (
    await createMesh({
      schema,
      identity: device,
      issuer: issuer.peerId,
      driver: bunSqliteDriver(":memory:"),
      now: () => T0,
    })
  ).unwrap();
  if (role !== undefined) {
    mesh.grants
      .register(
        issueGrant(issuer, {
          account: "acct_reader",
          device: device.peerId,
          role,
          // SAFETY: a test fixture instance in the documented kind:id form
          partitions: [ACME] as never,
          validFor: Temporal.Duration.from({ hours: 1 }),
          now: T0,
        }),
      )
      .unwrap();
  }
  return { mesh, api: meshApi(mesh, { books }, { instance: ACME }) };
};

describe("api.books.* is the whole surface", () => {
  test("a query is inert until something runs it, and two identical asks share one key", async () => {
    const { mesh, api } = await open("member");
    const a = api.books.list({ shelf: "sci-fi" });
    const b = api.books.list({ shelf: "sci-fi" });
    const other = api.books.list({});

    expect(a.kind).toBe("query");
    expect(a.path).toBe("books.list");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(other.key);
    // nothing ran: the row a later create writes is not in any of them yet
    expect(await mesh.engine.eventsSince(new Map()).then((r) => r.unwrap().length)).toBe(0);
    await mesh.stop();
  });

  test("a mutation returns the event it became, and the query then sees the row", async () => {
    const { mesh, api } = await open("member");
    const created = await api.books.create({ id: "b1", title: "Dune" });

    expect(created.isOk()).toBe(true);
    const { eventId, data } = created.unwrap();
    expect(String(eventId)).toMatch(/^[0-9a-f]{64}-\d+$/);
    expect(data).toEqual({ id: "b1" });

    const rows = await api.books.list({}).run();
    expect(rows).toEqual([{ id: "b1", title: "Dune", shelf: null }]);
    await mesh.stop();
  });

  test("input the schema refuses is an Err, and writes nothing", async () => {
    const { mesh, api } = await open("member");
    const refused = await api.books.create({ id: "b2", title: "" });

    expect(refused.isErr()).toBe(true);
    expect(await mesh.engine.eventsSince(new Map()).then((r) => r.unwrap().length)).toBe(0);
    await mesh.stop();
  });

  test("a write the caller's rules deny is an Err, not a throw", async () => {
    const { mesh, api } = await open("viewer");
    const denied = await api.books.create({ id: "b3", title: "Dune" });

    expect(denied.isErr()).toBe(true);
    expect(await mesh.engine.eventsSince(new Map()).then((r) => r.unwrap().length)).toBe(0);
    await mesh.stop();
  });
});
