import type { ColumnName } from "@syncmesh/kernel";
import type { WindowRow } from "@syncmesh/window";

import { SERVED_READ_TIMEOUT, servedReadDdl } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { ReadFailed, ReadRefused, createServerWindows, decodeWindowFrame } from "@syncmesh/window";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias, pgSchema, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import { query } from "../index.js";
import { servedReads } from "../served.js";
import {
  ALICE,
  BOB,
  POSTGRES_URL,
  SERVER,
  after,
  eventually,
  mailId,
  pipe,
  runId,
  schemaFor,
  seedMailbox,
  served,
  urlAs,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the mail table's own column */
const SUBJECT = "subject" as ColumnName;

type Fixture = Awaited<ReturnType<typeof served>>;

const ids = (rows: readonly WindowRow[]) => rows.map((r) => r.key);
/** `n` ids counting down from mail `from`: a newest-first page. */
const down = (from: number, n: number) => Array.from({ length: n }, (_, i) => mailId(from - i));
const inbox = (limit: number, cursor?: number) => ({
  path: "mail.inbox",
  input:
    cursor === undefined
      ? { folder: "inbox", limit }
      : { folder: "inbox", limit, after: after(cursor) },
});

/** Every key any frame since `from` put: what a test reads to prove a row never travelled. */
const putSince = (frames: readonly Uint8Array[], from: number) =>
  frames.slice(from).flatMap((bytes) => {
    const frame = decodeWindowFrame(bytes).unwrap();
    return frame?.kind === "rows" ? frame.puts.map((p) => p.key) : [];
  });

suite("served reads over a real Postgres and its logical replication (D43, E27)", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await served({
      seed: async (pg, mail) => {
        await seedMailbox(100)(pg, mail);
        // bob's mail is newer than all of alice's and in the same folder
        await pg.unsafe(
          `INSERT INTO ${mail} SELECT 'b-' || n, 'bob', 'inbox', $1::timestamptz, 'bob ' || n FROM generate_series(1, 5) n`,
          ["2027-01-01T00:00:00Z"],
        );
      },
    });
  });
  afterEach(() => fx.close());

  test("opening a page sends the reader's newest rows once, as a reset; the read rule decides first", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(100, 5));
    expect(decodeWindowFrame(frames.at(-1) ?? new Uint8Array()).unwrap()).toMatchObject({
      kind: "rows",
      reset: true,
      version: 1,
    });
    const bob = pipe(fx.sourceFor(BOB));
    bob.client.open("inbox", inbox(5));
    await bob.server.idle();
    expect(ids(bob.client.rows("inbox"))).toEqual(["b-5", "b-4", "b-3", "b-2", "b-1"]);
  });

  test("the next page is the input's `after`; its rows travel under it, the old page's leave", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(6));
    await server.idle();
    client.open("inbox", inbox(6, 97));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(96, 6));
    const half = decodeWindowFrame(frames.at(-1) ?? new Uint8Array()).unwrap();
    if (half?.kind !== "rows") throw new Error("expected a rows frame");
    // a row is one read's row: 96 and 95 travel again under the input that now shows them
    expect(half.puts.map((p) => p.key)).toEqual(down(96, 6));
    expect(half.dels.map((d) => d.key)).toEqual(down(100, 6));
    client.open("inbox", inbox(6, 91));
    await server.idle();
    expect(ids(client.rows("inbox"))).toEqual(down(90, 6));
    expect(server.held()).toBe(6);
  });

  test("an INSERT inside the page arrives live; one below a full page never travels", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    await fx.insert(101);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(101), "the insert to arrive");
    expect(ids(client.rows("inbox"))).toEqual(down(101, 5));
    const mark = frames.length;
    // older than every row on the page: below a full page, so the page cannot move
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.mail} VALUES ('old-1', 'alice', 'inbox', '2025-06-01T00:00:00Z', 'old')`,
    );
    await fx.insert(102);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(102), "the second insert");
    await server.idle();
    expect(putSince(frames, mark)).toEqual([mailId(102)]);
    expect(putSince(frames, 0)).not.toContain("old-1");
    expect(server.held()).toBe(5);
  });

  test("a DELETE inside the page pulls the next row up; one below it sends no row", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    await fx.pg.unsafe(`DELETE FROM ${fx.names.mail} WHERE id = $1`, [mailId(98)]);
    await eventually(() => !ids(client.rows("inbox")).includes(mailId(98)), "the delete");
    expect(ids(client.rows("inbox"))).toEqual([100, 99, 97, 96, 95].map(mailId));
    const mark = frames.length;
    await fx.pg.unsafe(`DELETE FROM ${fx.names.mail} WHERE id = $1`, [mailId(10)]);
    await fx.insert(103);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(103), "the marker");
    expect(putSince(frames, mark)).toEqual([mailId(103)]);
  });

  test("an UPDATE out of the handler's `where` leaves the page; back in, it returns", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(3));
    await server.idle();
    const move = (n: number, folder: string) =>
      fx.pg.unsafe(`UPDATE ${fx.names.mail} SET folder = $1 WHERE id = $2`, [folder, mailId(n)]);
    await move(99, "archive");
    await eventually(
      () => ids(client.rows("inbox")).join() === [100, 98, 97].map(mailId).join(),
      "leaving",
    );
    await move(99, "inbox");
    await eventually(() => ids(client.rows("inbox")).join() === down(100, 3).join(), "returning");
    await fx.pg.unsafe(`UPDATE ${fx.names.mail} SET subject = 'renamed' WHERE id = $1`, [
      mailId(100),
    ]);
    await eventually(() => client.rows("inbox")[0]?.row.get(SUBJECT) === "renamed", "the rename");
  });

  test("another reader's rows never enter, even newest and in the folder; their INSERT sends nothing", async () => {
    const { client, server, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    const mark = frames.length;
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.mail} VALUES ('b-9', 'bob', 'inbox', '2030-01-01T00:00:00Z', 'newest of all')`,
    );
    await fx.insert(104);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(104), "alice's marker");
    expect(putSince(frames, mark)).toEqual([mailId(104)]);
  });

  test("a count inside the handler counts what the reader may read, not the table", async () => {
    const count = async (where: string) =>
      (
        await fx.pg.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${fx.names.mail} ${where}`,
        )
      )[0]?.n ?? -1;
    const mine = await count("WHERE owner = 'alice'");
    const all = await count("");
    expect(mine).toBeLessThan(all);
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("mine", { path: "mail.tallied", input: { total: mine, limit: 1 } });
    client.open("all", { path: "mail.tallied", input: { total: all, limit: 1 } });
    await server.idle();
    expect(client.rows("mine")).toHaveLength(1);
    expect(client.rows("all")).toEqual([]);
  });

  test("refused, failing closed: a served table with no read rule, an unknown read, a refused input", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("open", { path: "mail.everyone", input: { limit: 5 } });
    client.open("nope", { path: "mail.nope", input: {} });
    client.open("zero", { path: "mail.inbox", input: { folder: "inbox", limit: 0 } });
    client.open("ok", inbox(2));
    await server.idle();
    expect(client.refusal("open")).toBe(`${fx.names.open} has no read rule, so no one may read it`);
    expect(client.refusal("nope")).toBe("no read mail.nope");
    expect(client.refusal("zero")).toBe("Too small: expected number to be >=1");
    expect(client.rows("open")).toEqual([]);
    expect(ids(client.rows("ok"))).toEqual(down(100, 2));
  });

  test("a change feed that dies fails every window; restarted, it reads them again and is live", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    await fx.cutFeed();
    await eventually(() => client.failure("inbox") !== undefined, "the window to fail");
    // the rows it had stay on screen while it is failed
    expect(ids(client.rows("inbox"))).toEqual(down(100, 5));
    // a commit made while no feed was reading reaches the window only through the re-read
    await fx.insert(101);
    fx.restoreFeed();
    await eventually(() => client.failure("inbox") === undefined, "the restarted feed");
    expect(ids(client.rows("inbox"))).toEqual(down(101, 5));
    await fx.insert(102);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(102), "a live insert after it");
    server.stop();
  });

  test("a lost patch is a gap: the client asks again and the server resnapshots it", async () => {
    const { client, server, loseNext, frames } = pipe(fx.sourceFor(ALICE));
    client.open("inbox", inbox(5));
    await server.idle();
    loseNext();
    const mark = frames.length;
    await fx.insert(101);
    await eventually(() => frames.length > mark, "the patch that is lost");
    expect(ids(client.rows("inbox"))).toEqual(down(100, 5));
    await fx.insert(102);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(102), "the resnapshot");
    expect(ids(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.status()).toBe("live");
  });

  test("a new socket opens several windows again and keeps each on screen until all arrived", async () => {
    const source = fx.sourceFor(ALICE);
    const { client, server } = pipe(source);
    client.open("top", inbox(3));
    client.open("deep", inbox(3, 50));
    await server.idle();
    server.stop();
    client.detach();
    await fx.insert(101);
    const seen: string[][][] = [];
    client.subscribe(() => seen.push([ids(client.rows("top")), ids(client.rows("deep"))]));
    const next = createServerWindows({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    await next.idle();
    expect(seen).toEqual([[down(101, 3), down(49, 3)]]);
    expect(client.status()).toBe("live");
    expect(client.held()).toBe(6);
    next.stop();
  });
});

/** A table no manifest names, which a served read must never reach, however it is spelled. */
const PRIVATE = `private_${runId()}`;

suite("what a served handler cannot reach, however it asks (D43, E13)", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await served({
      seed: async (pg, mail) => {
        await seedMailbox(3)(pg, mail);
        await pg.unsafe(`INSERT INTO ${mail} VALUES ('b-1', 'bob', 'inbox', now(), 'BOB SECRET')`);
      },
    });
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.open} VALUES ('o-1', 'alice', 'inbox', now(), 'NO RULE')`,
    );
    await fx.pg.unsafe(`CREATE TABLE ${PRIVATE} (id text PRIMARY KEY, secret text)`);
    await fx.pg.unsafe(`INSERT INTO ${PRIVATE} VALUES ('s', 'NOT IN THE MANIFEST')`);
  });
  afterAll(async () => {
    await fx.pg.unsafe(`DROP TABLE IF EXISTS ${PRIVATE}`);
    await fx.close();
  });

  /* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-explicit-any, typescript/no-explicit-any, typescript/no-unsafe-return, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- each handler here is written as an attacker would, against the Drizzle the server hands it */
  /** Serves one handler to alice, as the read `r`, and says what came back. */
  const read = async (
    handler: (context: { readonly db: any }) => any,
    options: { readonly readRole?: string } = {},
  ) => {
    // SAFETY: the handler is written against the Drizzle `servedReads` hands it
    const router = { r: query.input(z.object({})).handler(handler as never) };
    const source = servedReads({
      router,
      schema: fx.schema,
      db: fx.db,
      principal: ALICE,
      self: SERVER,
      onCommit: () => () => undefined,
      readRole: options.readRole ?? fx.roles.reader,
      // a refusal here is the read's own fault, not a deploy still running
      grace: Temporal.Duration.from({ seconds: 0 }),
    });
    const page = await source.readPage({ path: "r", input: {} });
    return page.map((p) => p.rows.map((r) => Object.fromEntries(r.row)));
  };
  /* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-explicit-any, typescript/no-explicit-any, typescript/no-unsafe-return, typescript/no-unsafe-call, typescript/no-unsafe-member-access */

  /** Whether bob's subject reached alice anywhere in what came back. */
  const leaks = (rows: readonly object[]) => JSON.stringify(rows).includes("BOB SECRET");

  test("the ruled table named inside a sql fragment is filtered by Postgres, not read whole", async () => {
    const m = fx.mail;
    const rows = await read(({ db }) =>
      db
        .select({ id: m.id, all: sql<string>`(select string_agg(subject, '|') from ${m})` })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
    expect(rows.isOk()).toBe(true);
    expect(leaks(rows.unwrap())).toBe(false);
    expect(rows.unwrap()[0]?.["all"]).toBe("subject 1|subject 2|subject 3");
  });

  test("a table with no rule, or none in the manifest, named in a fragment is refused by Postgres", async () => {
    const m = fx.mail;
    for (const named of [sql`${fx.open}`, sql.raw(PRIVATE)]) {
      const rows = await read(({ db }) =>
        db
          .select({ id: m.id, peek: sql<string>`(select count(*) from ${named})` })
          .from(m)
          .orderBy(m.id)
          .limit(1),
      );
      expect(rows.isErr() && ReadRefused.is(rows.error)).toBe(true);
      expect(rows.isErr() && rows.error.message).toStartWith("permission denied for table");
    }
  });

  test("a join chained after where or $dynamic, in a subquery, sees only the reader's rows", async () => {
    const m = fx.mail;
    const other = alias(m, "other");
    const rows = await read(({ db }) => {
      const afterWhere = db
        .select({ s: sql<string>`string_agg(other.subject, '|')` })
        .from(m)
        .where(sql`true`)
        .innerJoin(other, sql`true`);
      const afterDynamic = db
        .select({ s: sql<string>`max(other.subject)` })
        .from(m)
        .$dynamic()
        .leftJoin(other, eq(other.owner, "bob"));
      return db
        .select({
          id: m.id,
          one: sql<string>`(${afterWhere})`,
          two: sql<string>`(${afterDynamic})`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1);
    });
    expect(rows.isOk()).toBe(true);
    expect(leaks(rows.unwrap())).toBe(false);
  });

  test("a subquery answers no yes-or-no question about another reader's rows", async () => {
    const m = fx.mail;
    const other = alias(m, "other");
    const rows = await read(({ db }) =>
      db
        .select()
        .from(m)
        .where(
          inArray(
            m.id,
            db
              .select({ id: m.id })
              .from(m)
              .where(sql`true`)
              .innerJoin(other, and(eq(other.owner, "bob"), sql`other.subject like 'BOB S%'`)),
          ),
        )
        .orderBy(m.id)
        .limit(10),
    );
    expect(rows.unwrap()).toEqual([]);
  });

  test("an alias of a table with no rule, named as the ruled table, does not borrow its rule", async () => {
    const borrowed = alias(fx.open, fx.names.mail);
    const rows = await read(({ db }) => db.select().from(borrowed).orderBy(borrowed.id).limit(10));
    expect(rows.isErr() && rows.error.message).toContain("has no read rule");
  });

  test("a table of the same name in another schema is not the served table, and is refused", async () => {
    const elsewhere = pgSchema("crm").table(fx.names.mail, { id: text().primaryKey() });
    const rows = await read(({ db }) => db.select().from(elsewhere).orderBy(elsewhere.id).limit(1));
    expect(rows.isErr() && rows.error.message).toBe(
      `crm.${fx.names.mail} is not served: only a sync: "window" table is read on the server`,
    );
  });

  test("a write hidden in a fragment is refused by the read-only transaction and the role", async () => {
    const m = fx.mail;
    const rows = await read(({ db }) =>
      db
        .select({
          id: m.id,
          gone: sql<number>`(with gone as (delete from ${m} returning 1) select count(*) from gone)`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
    expect(rows.isErr() && ReadRefused.is(rows.error)).toBe(true);
    const [left] = await fx.pg.unsafe(`SELECT count(*)::int AS count FROM ${fx.names.mail}`);
    expect(left?.["count"]).toBe(4);
  });

  test("a server with no read role serves nothing", async () => {
    const m = fx.mail;
    const rows = await read(({ db }) => db.select().from(m).orderBy(m.id).limit(10), {
      readRole: "",
    });
    expect(rows.isErr() && rows.error.message).toContain("no readRole");
  });

  test("a read with no limit is refused before it runs", async () => {
    const m = fx.mail;
    const before = fx.statements.length;
    const rows = await read(({ db }) => db.select().from(m).orderBy(m.id));
    expect(rows.isErr() && rows.error.message).toContain("must .limit()");
    // the role and the reader's settings, then nothing: the query never ran
    expect(fx.statements.slice(before).some((s) => s.sql.includes("order by"))).toBe(false);
  });

  test("a path naming something every object has is no read, and does not throw", async () => {
    const source = fx.sourceFor(ALICE);
    for (const path of ["constructor", "constructor.name.x", "__proto__", "toString"]) {
      const page = await source.readPage({ path, input: {} });
      expect(page.isErr() && page.error.message).toBe(`no read ${path}`);
    }
  });

  /** Bob's mail as alice's read counts it, while the fragment claims to be bob. */
  const spoofed = (claim: ReturnType<typeof sql>) => {
    const m = fx.mail;
    return read(({ db }) =>
      db
        .select({
          id: m.id,
          bob: sql<string>`(select count(*)::text from ${m} x where x.owner = 'bob' and ${claim} is not null)`,
          seen: sql<string>`(select count(*)::text from (select ${claim} a) s cross join lateral (select 1 from ${m} y where y.owner = 'bob') z)`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
  };

  test("a fragment that sets the reader's account to bob's reads none of bob's rows", async () => {
    for (const claim of [
      sql`set_config('syncmesh.account', 'bob', true)`,
      sql`set_config('syncmesh.role', 'owner', true)`,
      sql`set_config('syncmesh.claims', '{"account":"bob"}', true)`,
    ]) {
      const rows = await spoofed(claim);
      expect(rows.unwrap()).toEqual([{ id: "m-0000001", bob: "0", seen: "0" }]);
    }
  });

  test("a fragment that goes back to its login, then reads, still reads as the reader", async () => {
    const m = fx.mail;
    const back = sql`set_config('role', 'none', true)`;
    const mine = await read(({ db }) =>
      db
        .select({
          id: m.id,
          back,
          all: sql<string>`query_to_xml(${`select subject from ${fx.names.mail}`}, true, false, '')::text`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
    expect(mine.isOk()).toBe(true);
    expect(leaks(mine.unwrap())).toBe(false);
    const hidden = await read(({ db }) =>
      db
        .select({
          id: m.id,
          back,
          all: sql<string>`query_to_xml(${`select secret from ${PRIVATE}`}, true, false, '')::text`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
    expect(hidden.isErr() && hidden.error.message).toStartWith("permission denied for table");
  });

  test("a fragment cannot name a second principal: the transaction is read-only by then", async () => {
    const m = fx.mail;
    const rows = await read(({ db }) =>
      db
        .select({
          id: m.id,
          again: sql<string>`syncmesh_served.enter(${fx.roles.reader}, '{"account":"bob","role":"owner","claims":{}}')::text`,
        })
        .from(m)
        .orderBy(m.id)
        .limit(1),
    );
    expect(rows.isErr() && rows.error.message).toBe(
      "cannot execute INSERT in a read-only transaction",
    );
  });

  test("a query a handler runs while building its own runs read-only, as the reader", async () => {
    const m = fx.mail;
    const ran = Promise.withResolvers<unknown>();
    const rows = await read(({ db }) => {
      db.select({
        user: sql<string>`current_user`,
        readOnly: sql<string>`current_setting('transaction_read_only')`,
      })
        .from(sql`(select 1) z`)
        .then(ran.resolve, ran.resolve);
      return db.select().from(m).orderBy(m.id).limit(1);
    });
    expect(rows.isOk()).toBe(true);
    expect(await ran.promise).toEqual([{ user: fx.roles.reader, readOnly: "on" }]);
  });

  test("a built query hands a handler no session to run statements of its own on", async () => {
    const m = fx.mail;
    const found: unknown[] = [];
    const rows = await read(({ db }) => {
      const q = db.select().from(m).orderBy(m.id).limit(1);
      found.push(q.session, Reflect.getOwnPropertyDescriptor(q, "session"), "session" in q);
      return q;
    });
    expect(rows.isOk()).toBe(true);
    expect(found).toEqual([undefined, undefined, false]);
  });

  test("a handler that throws is refused, not read again", async () => {
    const rows = await read(() => {
      throw new Error("no such folder");
    });
    expect(rows.isErr() && ReadRefused.is(rows.error)).toBe(true);
    expect(rows.isErr() && rows.error.message).toBe("r threw building its query: no such folder");
  });

  test("a statement past the timeout is cancelled, and the read fails rather than is refused", async () => {
    const m = fx.mail;
    const router = {
      r: query.input(z.object({})).handler(({ db }) =>
        db
          .select({ id: m.id, slow: sql<string>`pg_sleep(2)::text` })
          .from(m)
          .orderBy(m.id)
          .limit(1),
      ),
    };
    const source = servedReads({
      router,
      schema: fx.schema,
      db: fx.db,
      principal: ALICE,
      self: SERVER,
      onCommit: () => () => undefined,
      readRole: fx.roles.reader,
      timeout: Temporal.Duration.from({ milliseconds: 50 }),
    });
    const page = await source.readPage({ path: "r", input: {} });
    expect(page.isErr() && ReadFailed.is(page.error)).toBe(true);
    expect(page.isErr() && page.error.message).toBe("canceling statement due to statement timeout");
  });

  test("a table the role may not read fails for the grace a deploy takes, then is refused", async () => {
    const m = fx.mail;
    const router = {
      r: query.input(z.object({})).handler(({ db }) =>
        db
          .select({ id: m.id, peek: sql<string>`(select count(*) from ${sql.raw(PRIVATE)})` })
          .from(m)
          .orderBy(m.id)
          .limit(1),
      ),
    };
    const grace = Temporal.Duration.from({ milliseconds: 100 });
    const source = servedReads({
      router,
      schema: fx.schema,
      db: fx.db,
      principal: ALICE,
      self: SERVER,
      onCommit: () => () => undefined,
      readRole: fx.roles.reader,
      grace,
    });
    const first = await source.readPage({ path: "r", input: {} });
    expect(first.isErr() && ReadFailed.is(first.error)).toBe(true);
    await Bun.sleep(grace.total("milliseconds") * 2);
    const later = await source.readPage({ path: "r", input: {} });
    expect(later.isErr() && ReadRefused.is(later.error)).toBe(true);
    expect(later.isErr() && later.error.message).toStartWith("permission denied for table");
  });
});

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-explicit-any, typescript/no-explicit-any, typescript/no-unsafe-return, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment -- each handler here is written as an attacker would, against the Drizzle the server hands it */
type Handler = (context: { readonly db: any }) => any;

/** One principal's page source over `routes`, with no feed: each test reads by hand. */
const sourceOver = (
  fx: Fixture,
  routes: Readonly<Record<string, Handler>>,
  options: {
    readonly principal?: typeof ALICE | typeof BOB;
    readonly db?: object;
    readonly timeout?: Temporal.Duration;
    readonly schema?: Fixture["schema"];
  } = {},
) =>
  servedReads({
    // SAFETY: each handler is written against the Drizzle `servedReads` hands it
    router: Object.fromEntries(
      Object.entries(routes).map(([path, handler]) => [
        path,
        query.input(z.object({})).handler(handler as never),
      ]),
    ),
    schema: options.schema ?? fx.schema,
    db: options.db ?? fx.db,
    principal: options.principal ?? ALICE,
    self: SERVER,
    onCommit: () => () => undefined,
    readRole: fx.roles.reader,
    // a refusal here is the read's own fault, not a deploy still running
    grace: Temporal.Duration.from({ seconds: 0 }),
    timeout: options.timeout ?? SERVED_READ_TIMEOUT,
  });

/** Alice's rows of `handler`, read as `r`. */
const readAs = async (fx: Fixture, handler: Handler) => {
  const page = await sourceOver(fx, { r: handler }).readPage({ path: "r", input: {} });
  return page.map((p) => p.rows.map((r) => Object.fromEntries(r.row)));
};

suite("what a served read leaves behind, and what its login may hold (D43)", () => {
  let fx: Fixture;
  const app = `syncmesh_app_${runId()}`;
  beforeAll(async () => {
    fx = await served({
      seed: async (pg, mail) => {
        await seedMailbox(3)(pg, mail);
        await pg.unsafe(`INSERT INTO ${mail} VALUES ('b-1', 'bob', 'inbox', now(), 'BOB SECRET')`);
      },
    });
    await fx.pg.unsafe(`CREATE TABLE ${PRIVATE}_2 (id text PRIMARY KEY, secret text)`);
    await fx.pg.unsafe(`INSERT INTO ${PRIVATE}_2 VALUES ('s', 'NOT IN THE MANIFEST')`);
    await fx.pg.unsafe(`CREATE ROLE "${app}" NOLOGIN`);
    await fx.pg.unsafe(`GRANT SELECT ON ${PRIVATE}_2 TO "${app}"`);
  });
  afterAll(async () => {
    await fx.pg.unsafe(`DROP TABLE IF EXISTS ${PRIVATE}_2`);
    await fx.pg.unsafe(`DROP ROLE IF EXISTS "${app}"`);
    await fx.close();
  });

  /** Alice's first mail with `x` beside it: what a fragment is put in. */
  const beside =
    (x: ReturnType<typeof sql>): Handler =>
    ({ db }) =>
      db.select({ id: fx.mail.id, x }).from(fx.mail).orderBy(fx.mail.id).limit(1);

  test("a db a handler kept is refused once its read has ended, and sends nothing", async () => {
    let kept: any;
    const rows = await readAs(fx, ({ db }) => {
      kept = db;
      return db.select().from(fx.mail).orderBy(fx.mail.id).limit(1);
    });
    expect(rows.isOk()).toBe(true);
    const sent = fx.statements.length;
    const enter = kept
      .select({
        a: sql<string>`syncmesh_served.enter(${fx.roles.reader}, '{"account":"bob","role":"owner","claims":{}}')::text`,
      })
      .from(sql`(select 1) z`);
    expect(
      await Promise.resolve(enter).then(
        () => "sent",
        (error: Error) => error.message,
      ),
    ).toBe("r used its db after its read ended: a handler's db is for that read");
    expect(fx.statements.length).toBe(sent);
    const [principals] = await fx.pg.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM syncmesh_served.principal`,
    );
    expect(principals).toEqual({ n: 0 });
  });

  test("a db one reader kept never runs in the next reader's transaction on that connection", async () => {
    const one = postgres(urlAs(fx.roles.login, fx.roles.password), { max: 1 });
    const db = drizzle({ client: one });
    const m = fx.mail;
    let kept: any;
    let late = Promise.resolve("unsent");
    const routes = {
      a: ({ db: mine }: { readonly db: any }) => {
        kept = mine;
        return mine.select().from(m).orderBy(m.id).limit(1);
      },
      // while bob's transaction holds the one connection, alice's db asks it for bob's mail
      b: ({ db: mine }: { readonly db: any }) => {
        late = kept
          .select({
            s: sql<string>`(select string_agg(subject, '|') from ${sql.raw(fx.names.mail)})`,
          })
          .from(sql`(select 1) z`)
          .then(
            () => "sent",
            (error: Error) => error.message,
          );
        return mine.select().from(m).orderBy(m.id).limit(1);
      },
    };
    expect((await sourceOver(fx, routes, { db }).readPage({ path: "a", input: {} })).isOk()).toBe(
      true,
    );
    const bob = await sourceOver(fx, routes, { db, principal: BOB }).readPage({
      path: "b",
      input: {},
    });
    expect(bob.isOk()).toBe(true);
    expect(await late).toBe("a used its db after its read ended: a handler's db is for that read");
    await one.end();
  });

  /** Advisory locks held by any session on `key`. */
  const locks = async (key: number) =>
    (
      await fx.pg.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1`,
        [key],
      )
    )[0];

  test("a session advisory lock a read takes is let go, even when a later read of the pass fails", async () => {
    const key = 4000 + Math.floor(Math.random() * 1000);
    const source = sourceOver(fx, {
      lock: beside(sql`pg_advisory_lock(${key}::bigint)::text`),
      bad: beside(sql`(1 / 0)::text`),
    });
    expect((await source.readPage({ path: "lock", input: {} })).isOk()).toBe(true);
    expect(await locks(key)).toEqual({ n: 0 });
    const both = await source.readPages?.([
      { path: "lock", input: {} },
      { path: "bad", input: {} },
    ]);
    expect(both?.map((page) => page.isOk())).toEqual([true, false]);
    expect(await locks(key)).toEqual({ n: 0 });
  });

  test("a fragment that turns its statement_timeout off is still cancelled once the pass is late", async () => {
    const source = sourceOver(
      fx,
      {
        off: beside(sql`set_config('statement_timeout', '0', true)`),
        slow: beside(sql`pg_sleep(10)::text`),
      },
      { timeout: Temporal.Duration.from({ milliseconds: 100 }) },
    );
    const started = Temporal.Now.instant();
    const pages = await source.readPages?.([
      { path: "off", input: {} },
      { path: "slow", input: {} },
    ]);
    const took = Temporal.Now.instant().since(started);
    expect(pages?.[0]?.isOk()).toBe(true);
    const slow = pages?.[1];
    expect(slow?.isErr() && ReadFailed.is(slow.error)).toBe(true);
    expect(slow?.isErr() && slow.error.message).toBe("canceling statement due to user request");
    expect(Temporal.Duration.compare(took, { seconds: 3 })).toBe(-1);
  });

  /** Runs `grant`, reads, takes it back with `revoke`, and answers what the read said. */
  const whileGranted = async (grant: string, revoke: string) => {
    await fx.pg.unsafe(grant);
    const rows = await readAs(fx, beside(sql`(select secret from ${sql.raw(`${PRIVATE}_2`)})`));
    await fx.pg.unsafe(revoke);
    return rows.isErr() ? rows.error.message : JSON.stringify(rows.value);
  };

  test("a login or read role that holds more than the read role is refused, not read through", async () => {
    const { reader, login } = fx.roles;
    expect(
      await whileGranted(
        `GRANT pg_read_all_data TO "${reader}"`,
        `REVOKE pg_read_all_data FROM "${reader}"`,
      ),
    ).toBe(
      `syncmesh: served reads log in as ${login}, which has the privileges of pg_read_all_data too, and a read can use them`,
    );
    expect(
      await whileGranted(`GRANT "${app}" TO "${reader}"`, `REVOKE "${app}" FROM "${reader}"`),
    ).toBe(
      `syncmesh: served reads log in as ${login}, which has the privileges of ${app} too, and a read can use them`,
    );
    expect(
      await whileGranted(
        `GRANT SELECT (secret) ON ${PRIVATE}_2 TO "${login}"`,
        `REVOKE SELECT (secret) ON ${PRIVATE}_2 FROM "${login}"`,
      ),
    ).toBe(
      `syncmesh: served reads log in as ${login}, which owns or was granted column secret of table public.${PRIVATE}_2`,
    );
    expect(
      await whileGranted(
        `GRANT SELECT ON ${PRIVATE}_2 TO "${reader}"`,
        `REVOKE SELECT ON ${PRIVATE}_2 FROM "${reader}"`,
      ),
    ).toBe(
      `syncmesh: the read role ${reader} was granted public.${PRIVATE}_2, which servedReadDdl does not serve`,
    );
    // all taken back: the read reaches the fragment, and Postgres refuses the table
    expect(await whileGranted(`SELECT 1`, `SELECT 1`)).toBe(
      `permission denied for table ${PRIVATE}_2`,
    );
  });

  test("the DDL warns of a table the read role can read that the manifest does not serve", async () => {
    const notices: string[] = [];
    const owner = postgres(POSTGRES_URL ?? "", {
      max: 1,
      onnotice: (notice) => void notices.push(notice.message ?? ""),
    });
    await owner.unsafe(`GRANT SELECT ON ${PRIVATE}_2 TO PUBLIC`);
    for (const statement of servedReadDdl(fx.schema, {
      role: fx.roles.reader,
      grantTo: fx.roles.login,
    }))
      await owner.unsafe(statement);
    await owner.unsafe(`REVOKE SELECT ON ${PRIVATE}_2 FROM PUBLIC`);
    await owner.end();
    expect(notices).toContain(
      `syncmesh: the read role ${fx.roles.reader} can read ${PRIVATE}_2, which the manifest does not serve: a served read could read all of it`,
    );
  });
});

suite(
  "a column rule holds for a sql fragment too: the ruled table is read through its view (D43, E06)",
  () => {
    let fx: Fixture;
    beforeAll(async () => {
      fx = await served({
        hideSubject: true,
        seed: async (pg, mail) => {
          await seedMailbox(3)(pg, mail);
          await pg.unsafe(
            `INSERT INTO ${mail} VALUES ('b-1', 'bob', 'inbox', now(), 'BOB SECRET')`,
          );
        },
      });
    });
    afterAll(() => fx.close());

    const beside =
      (x: ReturnType<typeof sql>): Handler =>
      ({ db }) =>
        db.select({ id: fx.mail.id, x }).from(fx.mail).orderBy(fx.mail.id).limit(1);

    test("the handler's own select reads the ruled column as null, the reader's rows only", async () => {
      const rows = await readAs(fx, ({ db }) =>
        db.select().from(fx.mail).orderBy(fx.mail.id).limit(5),
      );
      expect(rows.unwrap().map((row) => [row["id"], row["subject"]])).toEqual([
        ["m-0000001", null],
        ["m-0000002", null],
        ["m-0000003", null],
      ]);
    });

    test("a fragment that names the table's ruled column is refused by Postgres", async () => {
      const rows = await readAs(
        fx,
        beside(sql`(select string_agg(subject, '|') from ${sql.raw(fx.names.mail)})`),
      );
      expect(rows.isErr() && rows.error.message).toBe(
        `permission denied for table ${fx.names.mail}`,
      );
    });

    test("a fragment reads the table's other columns, and the view, only as the reader may", async () => {
      const rows = await readAs(
        fx,
        beside(
          sql`(select count(*)::text from ${sql.raw(fx.names.mail)}) || ':' || (select count(*)::text || '/' || count(subject)::text from ${sql.raw(`syncmesh_served."read:${fx.names.mail}"`)})`,
        ),
      );
      expect(rows.unwrap()).toEqual([{ id: "m-0000001", x: "3:3/0" }]);
    });

    test("the DDL again keeps the view; without the rule it drops it and grants the table back", async () => {
      const run = async (schema: Fixture["schema"]) => {
        for (const statement of servedReadDdl(schema, {
          role: fx.roles.reader,
          grantTo: fx.roles.login,
        }))
          await fx.pg.unsafe(statement);
      };
      const view = async () =>
        (
          await fx.pg.unsafe<{ view: string | null }[]>(`SELECT to_regclass($1)::text AS view`, [
            `syncmesh_served."read:${fx.names.mail}"`,
          ])
        )[0];
      await run(fx.schema);
      expect(await view()).toEqual({ view: `syncmesh_served."read:${fx.names.mail}"` });
      await run(schemaFor(fx.names.mail, fx.names.open));
      expect(await view()).toEqual({ view: null });
      // the table is the role's to read whole again, each row by its rule
      const unruled = sourceOver(
        fx,
        { r: beside(sql`(select count(subject)::text from ${sql.raw(fx.names.mail)})`) },
        { schema: schemaFor(fx.names.mail, fx.names.open) },
      );
      const page = (await unruled.readPage({ path: "r", input: {} })).unwrap();
      expect(page.rows.map((r) => Object.fromEntries(r.row))).toEqual([
        { id: "m-0000001", x: "3" },
      ]);
    });
  },
);
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-explicit-any, typescript/no-explicit-any, typescript/no-unsafe-return, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-assignment */
