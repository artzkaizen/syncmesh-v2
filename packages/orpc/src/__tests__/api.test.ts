import { createMesh } from "@syncmesh/client";
import { Result } from "@syncmesh/result";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { AuthorityLink } from "../api.js";

import { meshApi, mutation, query } from "../api.js";
import { AuthorityUnreachable, InputInvalid, NothingWritten } from "../errors.js";

const book = sqliteTable("book", {
  id: text().primaryKey(),
  title: text().notNull(),
  shelf: text(),
});

const org = partition("org", { roles: ladder("owner", "member", "viewer") });
const schema = syncSchema({
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text(), shelf: t.text().nullable() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member"), read: role("viewer") }),
    },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 70 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ORG = "acme";
const ACME = `org:${ORG}`;

/** The one surface an app touches: a read that has not run, and a write that is one event. */
const books = {
  list: query
    // `orgId` is not decoration: scope is input, never construction (ch. 3), and this is where
    // the binding reads which replica the call is about
    .input(z.object({ orgId: z.string(), shelf: z.string().optional() }))
    .handler(({ input, db }) =>
      input.shelf === undefined
        ? db.select().from(book)
        : db.select().from(book).where(eq(book.shelf, input.shelf)),
    ),

  create: mutation
    .input(z.object({ orgId: z.string(), id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      await db.insert(book).values({ id: input.id, title: input.title });
      return { id: input.id };
    }),

  /** Idempotent by construction: the second tap stages nothing, which is the point (§2.7). */
  ensure: mutation
    .input(z.object({ orgId: z.string(), id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      await db.insert(book).values({ id: input.id, title: input.title }).onConflictDoNothing();
      return { id: input.id };
    }),
};

/**
 * The server's half, as the app sees it: a path and two schemas. No handler, because a handler
 * here would be a handler in the app's bundle.
 */
const billing = {
  charge: mutation
    .input(z.object({ bookId: z.string(), cents: z.number().int().positive() }))
    .output(z.object({ receiptId: z.string() }))
    .authority(),
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
  return { mesh, api: meshApi({ ...mesh, self: device.peerId }, { books }) };
};

/** A mesh whose authority calls go to `link` instead of over HTTP. */
const withAuthority = async (link?: AuthorityLink) => {
  const { mesh } = await open("member");
  const options = link === undefined ? {} : { link };
  return { mesh, api: meshApi({ ...mesh, self: device.peerId }, { books, billing }, options) };
};

describe("api.books.* is the whole surface", () => {
  test("a query is inert until something runs it, and two identical asks share one key", async () => {
    const { mesh, api } = await open("member");
    const a = api.books.list({ orgId: ORG, shelf: "sci-fi" });
    const b = api.books.list({ orgId: ORG, shelf: "sci-fi" });
    const other = api.books.list({ orgId: ORG });

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
    const created = await api.books.create({ orgId: ORG, id: "b1", title: "Dune" }).committed;

    expect(created.isOk()).toBe(true);
    const { eventId, data } = created.unwrap();
    expect(String(eventId)).toMatch(/^[0-9a-f]{64}-\d+$/);
    expect(data).toEqual({ id: "b1" });

    const rows = await api.books.list({ orgId: ORG }).run();
    expect(rows).toEqual([{ id: "b1", title: "Dune", shelf: null }]);
    await mesh.stop();
  });

  test("input the schema refuses is an Err, and writes nothing", async () => {
    const { mesh, api } = await open("member");
    const refused = await api.books.create({ orgId: ORG, id: "b2", title: "" }).committed;

    expect(refused.isErr()).toBe(true);
    expect(await mesh.engine.eventsSince(new Map()).then((r) => r.unwrap().length)).toBe(0);
    await mesh.stop();
  });

  test("a write the caller's rules deny is an Err, not a throw", async () => {
    const { mesh, api } = await open("viewer");
    const denied = await api.books.create({ orgId: ORG, id: "b3", title: "Dune" }).committed;

    expect(denied.isErr()).toBe(true);
    expect(await mesh.engine.eventsSince(new Map()).then((r) => r.unwrap().length)).toBe(0);
    await mesh.stop();
  });
});

describe("a call the device cannot run", () => {
  test("goes to the link, named by its path, with its input already validated", async () => {
    let calledPath = "";
    let calledInput: unknown = undefined;
    const { mesh, api } = await withAuthority(async (path, input) => {
      calledPath = path;
      calledInput = input;
      return Result.ok({ receiptId: "r1" });
    });

    const charged = await api.billing.charge({ bookId: "b1", cents: 500 });
    expect(charged.unwrap()).toEqual({ receiptId: "r1" });
    expect(calledPath).toBe("billing.charge");
    expect(calledInput).toEqual({ bookId: "b1", cents: 500 });
    await mesh.stop();
  });

  test("input the schema refuses never reaches the link", async () => {
    let called = false;
    const { mesh, api } = await withAuthority(async () => {
      called = true;
      return Result.ok({ receiptId: "never" });
    });

    const refused = await api.billing.charge({ bookId: "b1", cents: -1 });
    expect(refused.isErr()).toBe(true);
    expect(called).toBe(false);
    await mesh.stop();
  });

  test("with no link configured it fails as itself, rather than silently doing nothing", async () => {
    const { mesh, api } = await withAuthority();
    const nowhere = await api.billing.charge({ bookId: "b1", cents: 500 });

    expect(nowhere.isErr()).toBe(true);
    // the failure names the call, so "nothing happened" is never the diagnosis
    expect(nowhere.isErr() && nowhere.error.message).toContain("billing.charge");
    await mesh.stop();
  });

  test("the link's own failure is the caller's Err, not a throw", async () => {
    const { mesh, api } = await withAuthority(async () =>
      Result.err(new Error("the card was declined")),
    );
    const declined = await api.billing.charge({ bookId: "b1", cents: 500 });

    expect(declined.isErr()).toBe(true);
    await mesh.stop();
  });
});

/**
 * What this layer mints, it tags (§2.7). The wire half was already right — `wireError` sends
 * `{ _tag, message, ...fields }` and the client revives the declared class — but the failures
 * born on this side were bare `Error`s carrying prose.
 *
 * Asserted with `instanceof` rather than by reading `_tag`: `CallError` is `Error` at the top
 * on purpose (a handler may throw a class this package never heard of), so narrowing to the
 * class is what a caller actually does.
 */
describe("the failures this layer mints carry a tag", () => {
  const failure = <T>(result: { isErr: () => boolean; error?: Error } & T): Error | undefined =>
    result.isErr() ? result.error : undefined;

  test("NothingWritten: an idempotent mutation can finally report 'already done'", async () => {
    const { api } = await open("member");
    const first = await api.books.ensure({ orgId: ORG, id: "b1", title: "Dune" }).committed;
    expect(first.isOk()).toBe(true);

    // the second tap stages nothing — which used to come back as Err("wrote nothing"), making
    // idempotence unexpressible: a caller could not tell *already done* from *failed*
    const again = await api.books.ensure({ orgId: ORG, id: "b1", title: "Dune" }).committed;
    const error = failure(again);
    expect(error).toBeInstanceOf(NothingWritten);
    if (error instanceof NothingWritten) expect(error.path).toBe("books.ensure");
  });

  test("InputInvalid: a rejected input is a tag, not a TypeError carrying prose", async () => {
    const { api } = await open("member");
    const refused = await api.books.create({ orgId: ORG, id: "b2", title: "" }).committed;
    expect(failure(refused)).toBeInstanceOf(InputInvalid);
  });

  test("AuthorityUnreachable: a gate with no link fails now, typed, naming the path", async () => {
    const { api } = await withAuthority();
    const answered = await api.billing.charge({ bookId: "b1", cents: 500 });
    const error = failure(answered);
    expect(error).toBeInstanceOf(AuthorityUnreachable);
    if (error instanceof AuthorityUnreachable) expect(error.path).toBe("billing.charge");
  });
});
