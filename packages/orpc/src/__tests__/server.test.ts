import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { AuthorityHandlers } from "../api.js";

import { createServer, httpLink, mutation, query } from "../index.js";

const rooms = sqliteTable("rooms", { id: text().primaryKey(), name: text().notNull() });

const schema = defineSchema({
  tables: {
    rooms: { columns: { id: t.text().primaryKey(), name: t.text() }, partition: "local" },
  },
});

const procedures = {
  rooms: {
    list: query.handler(({ db }) => db.select().from(rooms)),
    reserveName: mutation
      .route({ method: "POST", path: "/room-names", tags: ["Rooms"] })
      .input(z.object({ name: z.string().min(1) }))
      .output(z.object({ roomId: z.string() }))
      .errors({ NAME_TAKEN: { message: "That name is already reserved" } })
      .authority(),
  },
};

/** The gate: uniqueness is a global invariant, so the write happens here or not at all. */
const handlers = {
  rooms: {
    reserveName: async ({ input, db, errors }) => {
      const held = await db.select().from(rooms).where(eq(rooms.name, input.name));
      if (held.length > 0) throw (errors.NAME_TAKEN ?? (() => new Error("declared")))();
      const roomId = `room-${input.name}`;
      await db.insert(rooms).values({ id: roomId, name: input.name });
      return { roomId };
    },
  },
} satisfies AuthorityHandlers<typeof procedures>;

const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 30 + i)).unwrap();

describe("createServer — a node with extra duties", () => {
  test("the gate decides over HTTP: first ask reserved, second refused by name", async () => {
    const server = await createServer({
      schema,
      procedures,
      handlers,
      identity,
      driver: bunSqliteDriver(":memory:"),
    });
    const served = Bun.serve({ port: 0, fetch: (request) => server.fetch(request) });
    try {
      const link = httpLink(`http://localhost:${served.port}`);

      const first = await link("rooms.reserveName", { name: "annex" });
      expect(first.unwrap()).toEqual({ roomId: "room-annex" });

      const second = await link("rooms.reserveName", { name: "annex" });
      const refusal = second.match({ ok: () => undefined, err: (e) => e });
      expect(refusal !== undefined && "tag" in refusal && refusal.tag).toBe("NAME_TAKEN");

      // the row the gate wrote is ordinary state, readable through the same procedures
      expect(await server.api.rooms.list().run()).toEqual([{ id: "room-annex", name: "annex" }]);

      const spec = server.openapi({ title: "Rooms", version: "1.0.0" });
      expect(spec).toMatchObject({
        openapi: "3.1.0",
        paths: { "/room-names": { post: { operationId: "rooms.reserveName", tags: ["Rooms"] } } },
      });
    } finally {
      await served.stop(true);
      await server.stop();
    }
  });
});
