import { local, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createClient, mutation, query, sqlite } from "../index.js";

const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

/** `local`: this device only, so one noun is the whole story — no grants, no authority. */
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

const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 21 + i)).unwrap();

describe("createClient — the client is the api (book ch. 8)", () => {
  test("procedures sit at the top level and the machinery sits beside them under $", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    await client.$ready;

    // tier one: the app's own procedures, unprefixed
    (await client.books.add({ id: "b1", title: "Dune" }).committed).unwrap();
    expect(await client.books.list().run()).toEqual([{ id: "b1", title: "Dune" }]);

    // tier two: framework surface, every name spelled with a $ no procedure can collide with
    // a local table's write never travels, so it leaves no ledger entry to settle
    expect((await client.$operations?.unsettled())?.unwrap()).toHaveLength(0);
    expect(client.$recovery.list()).toEqual([]);
    expect(client.$status.get().health).toBe("offline"); // no medium configured: nothing carries
    expect(client.$transports.list()).toEqual([]);
    expect(client.$inspect.handles().observers).toBe(0);

    await client.$flush(); // never rejects, even with nothing to flush
    await client.$close();
  });

  test("$close is the mesh's stop: a second open of the same file proves it let go", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    await client.$ready;
    await client.$close();
    expect(client.$mesh.running()).toBe(false);
  });
});
