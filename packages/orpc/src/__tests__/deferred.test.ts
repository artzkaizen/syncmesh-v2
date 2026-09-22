import type { SqlDriver } from "@syncmesh/storage";

import { local, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createClient, mutation, query, sqlite } from "../index.js";

const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

/** `local`: this device only, so the round trip needs no grant and no authority to write it. */
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

/**
 * A driver that opens and then cannot write — the shape a real failure takes. Passing a bad path
 * to `bunSqliteDriver` would throw while the argument is being evaluated, never reaching the call
 * under test.
 */
const fullDisk = {
  dialect: "sqlite",
  run: () => Promise.reject(new Error("no space left on device")),
  all: () => Promise.reject(new Error("no space left on device")),
} satisfies SqlDriver;

/**
 * The client is a value, and the database opens underneath it (book ch. 8).
 *
 * What is under test is the gap: a client handed out before there is a mesh, and every surface a
 * screen touches in its first frame answering honestly across it. Reads are pending, writes wait,
 * `$status` says `opening`, and nothing throws — because a screen drawn on the first frame is
 * going to ask, and `undefined` is not an answer it can render.
 */
describe("createClient, before the mesh exists", () => {
  test("the client is there at once, and $ready is when the mesh is", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    // no await: the api is fully built, because a descriptor needs no mesh to be built from
    expect(client.books.list()["~mesh"].path).toBe("books.list");
    expect(client.$status.get().health).toBe("opening");
    expect(client.$status.get().sources.size).toBe(0);

    await client.$ready;
    // whatever the mesh says now — with no transport configured, nothing carries
    expect(client.$status.get().health).toBe("offline");
    await client.$close();
  });

  test("a read taken before the mesh is pending, then answers — the same shape a screen already draws", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    // the descriptor is built and subscribed in the first frame, before anything has opened
    const live = client.books.list()["~mesh"].live();
    expect(live.snapshot().status).toBe("pending");
    expect(live.snapshot().answered).toBe(false);
    expect(live.snapshot().data).toEqual([]);

    const seen: number[] = [];
    live.subscribe((rows) => void seen.push(rows.length));
    (await client.books.add({ id: "b1", title: "Dune" }).committed).unwrap();
    await live.ready;

    expect(live.snapshot().answered).toBe(true);
    // and the subscription taken before the mesh is the one that hears about the row
    expect(seen.at(-1)).toBe(1);
    live.release();
    await client.$close();
  });

  test("a write issued before the mesh commits once it exists, under the id it already handed back", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    });
    // no await anywhere above: this is the first line of an app that writes on launch
    const write = client.books.add({ id: "b2", title: "Ubik" });
    expect(write.id).toMatch(/^[0-9a-f-]{36}$/);
    (await write.committed).unwrap();
    expect(await client.books.list()["~mesh"].run()).toEqual([{ id: "b2", title: "Ubik" }]);
    await client.$close();
  });

  test("a store that will not open is a rejected $ready, and every surface says the same thing after", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: fullDisk }),
    });
    const refused = await client.$ready.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(String(refused)).toMatch(/could not open/i);
    // the sentence rather than `undefined`, on the surface an app would reach for next
    expect(() => client.$mesh).toThrow(/could not open/i);
    expect(client.$status.get().health).toBe("opening");
  });

  test("the failure carries the tagged cause, so a caller who wants to branch still can", async () => {
    const client = createClient({
      schema,
      procedures,
      identity,
      storage: sqlite({ driver: fullDisk }),
    });
    const thrown = await client.$ready.catch((cause: unknown) => cause);
    // SAFETY: the call above is asserted to reject in the test before this one
    const panicked = thrown as Error;
    const cause = panicked.cause;
    expect(cause).toBeInstanceOf(Error);
    // SAFETY: `_tag` is optional on every Error and read only to name which failure it was
    expect((cause as Error & { readonly _tag?: string })._tag).toBe("StoreFailure");
  });
});
