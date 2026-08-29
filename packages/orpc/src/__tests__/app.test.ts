import type { SqlDriver } from "@syncmesh/storage";

import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createApp, mutation, query } from "../index.js";

const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

/** `local`: this device only, so the round trip needs no grant and no authority to write it. */
const schema = defineSchema({
  tables: {
    book: { columns: { id: t.text().primaryKey(), title: t.text() }, partition: "local" },
  },
});

const procedures = {
  books: {
    list: query.handler(({ mesh }) => mesh.db.select().from(book)),
    add: mutation
      .input(z.object({ id: z.string(), title: z.string().min(1) }))
      .handler(async ({ input, mesh }) => {
        await mesh.db.insert(book).values(input);
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

describe("createApp", () => {
  test("hands back the app itself: nothing to unwrap, and no mesh to thread", async () => {
    const { api, mesh } = await createApp({
      schema,
      procedures,
      identity,
      driver: bunSqliteDriver(":memory:"),
    });

    (await api.books.add({ id: "b1", title: "Dune" })).unwrap();
    expect(await api.books.list().run()).toEqual([{ id: "b1", title: "Dune" }]);
    await mesh.stop();
  });

  test("a store that will not open throws, naming what failed", async () => {
    await expect(createApp({ schema, procedures, identity, driver: fullDisk })).rejects.toThrow(
      /could not open/i,
    );
  });

  test("the failure carries the tagged cause, so a caller who wants to branch still can", async () => {
    const thrown = await createApp({ schema, procedures, identity, driver: fullDisk }).catch(
      (cause: unknown) => cause,
    );
    // SAFETY: the call above is asserted to reject in the test before this one
    const panicked = thrown as Error;
    const cause = panicked.cause;
    expect(cause).toBeInstanceOf(Error);
    // SAFETY: `_tag` is optional on every Error and read only to name which failure it was
    expect((cause as Error & { readonly _tag?: string })._tag).toBe("StoreFailure");
  });
});
