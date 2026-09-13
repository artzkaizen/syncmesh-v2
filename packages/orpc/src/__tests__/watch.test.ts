import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { createApp, mutation, query, watch } from "../index.js";

const products = sqliteTable("products", {
  id: text().primaryKey(),
  priceCents: integer().notNull(),
});

/** `local`: this device only, so the fixed point needs no grants and no second peer. */
const schema = defineSchema({
  tables: {
    products: {
      columns: { id: t.text().primaryKey(), priceCents: t.integer() },
      partition: "local",
    },
  },
});

const FLOOR = 120;

const procedures = {
  products: {
    list: query.handler(({ mesh }) => mesh.db.select().from(products)),
    add: mutation
      .input(z.object({ id: z.string(), priceCents: z.number().int() }))
      .handler(async ({ input, mesh }) => {
        await mesh.db.insert(products).values(input);
        return input;
      }),
    reprice: mutation
      .input(z.object({ id: z.string(), priceCents: z.number().int() }))
      .handler(async ({ input, mesh }) => {
        await mesh.db
          .update(products)
          .set({ priceCents: input.priceCents })
          .where(eq(products.id, input.id));
        return input;
      }),
  },
};

const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 21 + i)).unwrap();

const settled = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("watch — detection is a subscription, enforcement is a write", () => {
  test("a below-floor price is corrected, and the watchdog converges instead of looping", async () => {
    const { api, mesh } = await createApp({
      schema,
      procedures,
      identity,
      driver: bunSqliteDriver(":memory:"),
    });

    let reactions = 0;
    const off = watch(api.products.list(), async (rows) => {
      reactions += 1;
      for (const row of rows)
        if (row.priceCents < FLOOR)
          (await api.products.reprice({ id: row.id, priceCents: FLOOR }).committed).unwrap();
    });

    (await api.products.add({ id: "p1", priceCents: 90 }).committed).unwrap();
    await settled();

    expect(await api.products.list().run()).toEqual([{ id: "p1", priceCents: FLOOR }]);
    const converged = reactions;
    await settled();
    expect(reactions).toBe(converged); // corrected state stops matching: the fixed point

    // a compliant write wakes the watchdog and changes nothing
    (await api.products.add({ id: "p2", priceCents: 500 }).committed).unwrap();
    await settled();
    expect((await api.products.list().run()).map((r) => r.priceCents).sort()).toEqual([120, 500]);

    off();
    await mesh.stop();
  });
});
