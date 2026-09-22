import { PGlite } from "@electric-sql/pglite";
import { pgliteDriver } from "@syncmesh/postgres";
import { local, syncSchema, t } from "@syncmesh/schema";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { z } from "zod";

import { createClient, mutation, postgres, query } from "../index.js";

/**
 * The node whose folded rows are somebody else's tables too (book ch. 18).
 *
 * A server is a node with extra duties and not a different world, so the thing worth proving is
 * not that a second dialect exists — it is that the fold lands **in the app's own schema**, where
 * a `SELECT` nobody in this library wrote can read it. That is the whole reason a server would
 * choose Postgres over the file a phone keeps: the report, the cron job and the service next door
 * already query this database, and none of them are going to ask the mesh for permission.
 *
 * PGlite rather than a server, because what is being checked is the wiring — that `postgres()`
 * reaches the driver, that the driver's own `dialect` is what every layer below reads, and that
 * the statements the engine emits are Postgres statements. `adapters/postgres` runs the same
 * store contract against a real server when `SYNCMESH_PG_URL` is set.
 */
const book = pgTable("book", { id: text().primaryKey(), title: text().notNull() });

/** The log's own table in this dialect (`dialect-postgres.ts`), read here as an outsider would. */
const LOG_TABLE = "syncmesh.events";

const schema = syncSchema({
  tables: {
    book: { columns: { id: t.text().primaryKey(), title: t.text() }, partition: local },
  },
});

const procedures = {
  books: {
    list: query.handler(({ db }) => db.select().from(book)),
    add: mutation
      .input(z.object({ id: z.string(), title: z.string().min(1) }))
      .handler(async ({ input, db }) => {
        await db.insert(book).values(input);
        return input;
      }),
  },
};

const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 31 + i)).unwrap();

describe("storage: postgres — the fold materializes into the app's own database", () => {
  test("a write through a procedure is a row a plain SELECT can read", async () => {
    const pg = new PGlite();
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: postgres({ driver: pgliteDriver(pg) }),
    });
    await client.$ready;

    (await client.books.add({ id: "b1", title: "Dune" }).committed).unwrap();
    expect(await client.books.list().run()).toEqual([{ id: "b1", title: "Dune" }]);

    // the point of the exercise: read it the way an existing backend would, over its own
    // connection, knowing nothing about meshes
    const rows = await pg.query<{ id: string; title: string }>(`SELECT id, title FROM book`);
    expect(rows.rows).toEqual([{ id: "b1", title: "Dune" }]);

    // and the log is in the same database, so one backup is the whole node rather than two halves
    const tables = await pg.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY name`,
    );
    const named = tables.rows.map((row) => row.name);
    expect(named).toContain("book");
    expect(named.length).toBeGreaterThan(1);

    await client.$close();
    await pg.close();
  });

  /**
   * The same node, stopped and started again — a second Postgres over the first one's data.
   *
   * The store suite next door keeps one `PGlite` alive per database name so a case that reopens
   * after `close` finds what it wrote, which tests the map rather than the database. This is the
   * node actually going away: the client closed, the engine gone, the first Postgres closed, and a
   * *second* one brought up over a dump of the first's data directory — PGlite's own answer to
   * durability where a real directory is not available (its Node filesystem does not run under
   * this test runner).
   *
   * Both halves have to come back. The rows are what an outside `SELECT` reads; the log is what
   * makes the node able to carry on rather than merely able to show something, and a node that
   * lost it would sync from zero while looking perfectly fine.
   */
  test("a node that stops and starts again finds its rows and its log", async () => {
    const first = new PGlite();
    const before = createClient({
      schema,
      procedures,
      identity,
      storage: postgres({ driver: pgliteDriver(first) }),
    });
    await before.$ready;
    (await before.books.add({ id: "b2", title: "Middlemarch" }).committed).unwrap();
    await before.$close();
    const dump = await first.dumpDataDir();
    await first.close();

    const second = new PGlite({ loadDataDir: dump });
    const after = createClient({
      schema,
      procedures,
      identity,
      storage: postgres({ driver: pgliteDriver(second) }),
    });
    await after.$ready;
    expect(await after.books.list().run()).toEqual([{ id: "b2", title: "Middlemarch" }]);

    const events = await second.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${LOG_TABLE}`);
    expect(events.rows[0]?.n).toBeGreaterThan(0);

    await after.$close();
    await second.close();
  }, 30_000);
});
