import type { SocketData } from "@syncmesh/relay";

import { createMesh } from "@syncmesh/client";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { ladder, local, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, decodeCbor } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AuthorityHandlers } from "../api.js";

import { createServer, httpLink, mutation, query, sqlite } from "../index.js";

const rooms = sqliteTable("rooms", { id: text().primaryKey(), name: text().notNull() });

const schema = syncSchema({
  tables: {
    rooms: { columns: { id: t.text().primaryKey(), name: t.text() }, partition: local },
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

/** A device's own schema for the custody test: what it writes into the room, ungranted. */
const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const deviceSchema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const device = async (url: string, n: number) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: deviceSchema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
    })
  ).unwrap();
const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

describe("createServer — a node with extra duties", () => {
  test("the gate decides over HTTP: first ask reserved, second refused by name", async () => {
    const server = await createServer({
      schema,
      procedures,
      handlers,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
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
      expect(await server.api.rooms.list()["~mesh"].run()).toEqual([
        { id: "room-annex", name: "annex" },
      ]);

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

describe("createServer — custody on the server's own port", () => {
  test("one Bun.serve answers procedures, upgrades sockets onto rooms, and describes a room on GET", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-inline-custody-"));
    const server = await createServer({
      schema,
      procedures,
      handlers,
      identity,
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
      custody: { dataDir, keepaliveMs: 60_000 },
    });
    const websocket = server.websocket ?? panic("inline custody carries Bun's socket callbacks");
    const served = Bun.serve<SocketData>({
      port: 0,
      fetch: (request, self) => server.fetch(request, self),
      websocket,
    });
    try {
      const http = `http://localhost:${String(served.port)}`;
      const ws = `ws://localhost:${String(served.port)}/rooms`;

      // a procedure, on the port custody shares
      const link = httpLink(http);
      expect((await link("rooms.reserveName", { name: "annex" })).unwrap()).toEqual({
        roomId: "room-annex",
      });

      // two devices through the same port converge on the `rooms` room
      const a = await device(ws, 7);
      const b = await device(ws, 160);
      await Promise.all([a.ready(), b.ready()]);
      const ha = a.on("org:acme").unwrap();
      const hb = b.on("org:acme").unwrap();
      await ha.db.insert(notes).values({ id: "n1", body: "from a" });
      expect(await until(async () => (await hb.db.select().from(notes)).length === 1)).toBe(true);

      // the room described, as JSON to a browser and as the wire's own bytes to a device
      const described = await fetch(`${http}/rooms`);
      expect(described.headers.get("content-type")).toBe("application/json");
      expect(await described.json()).toMatchObject({
        room: "rooms",
        relay: server.custody?.peerId,
        clients: 2,
      });
      const bytes = await fetch(`${http}/rooms`, { headers: { accept: "application/cbor" } });
      expect(bytes.headers.get("content-type")).toBe("application/cbor");
      const decoded = decodeCbor(new Uint8Array(await bytes.arrayBuffer())).unwrap();
      expect(decoded instanceof Map && decoded.get("room")).toBe("rooms");

      // without Bun's server in hand an upgrade cannot be taken, and the answer says so
      const bare = await server.fetch(
        new Request(`${http}/rooms`, { headers: { upgrade: "websocket" } }),
      );
      expect(bare.status).toBe(426);

      await a.stop();
      await b.stop();
    } finally {
      await served.stop(true);
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
