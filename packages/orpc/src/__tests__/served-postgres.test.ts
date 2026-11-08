import type { ColumnName } from "@syncmesh/kernel";
import type { WindowRow } from "@syncmesh/window";

import { Temporal } from "@syncmesh/temporal";
import { ReadFailed, ReadRefused, createServerWindows, decodeWindowFrame } from "@syncmesh/window";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias, pgSchema, text } from "drizzle-orm/pg-core";
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
  seedMailbox,
  served,
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
