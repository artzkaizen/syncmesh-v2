import { createMesh } from "@syncmesh/client";
import { tableDigests } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRelay } from "../index.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = () =>
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
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await tick(15);
  }
  return check();
};

/** One device on a room, ungranted: the schema is the only check, which is all a host test needs. */
const device = async (url: string, n: number) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
    })
  ).unwrap();

describe("startRelay on Node — the same host over node:http and ws", () => {
  test("two devices through the Node mount converge on one room; a restart keeps the log", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-relay-node-"));
    try {
      const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
      const url = `${relay.url}/notes`;
      const a = await device(url, 7);
      const b = await device(url, 160);
      await Promise.all([a.ready(), b.ready()]);
      const ha = a.on("org:acme").unwrap();
      const hb = b.on("org:acme").unwrap();
      const count = (mesh: typeof ha) =>
        mesh.db
          .select()
          .from(notes)
          .then((rows) => rows.length);

      await ha.db.insert(notes).values({ id: "n1", body: "from a" });
      expect(await until(async () => (await count(hb)) === 1)).toBe(true);
      await hb.db.insert(notes).values({ id: "n2", body: "from b" });
      expect(await until(async () => (await count(ha)) === 2 && (await count(hb)) === 2)).toBe(
        true,
      );
      expect(tableDigests(a.engine.state())).toEqual(tableDigests(b.engine.state()));
      await a.stop();
      await b.stop();
      const peerBefore = relay.peerId;
      await relay.stop();

      // the same directory, a fresh process: the log and the room's key are both on disk
      const revived = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
      const c = await device(`${revived.url}/notes`, 200);
      await c.ready();
      const hc = c.on("org:acme").unwrap();
      expect(await until(async () => (await count(hc)) === 2)).toBe(true);
      expect(revived.peerId).not.toBe(peerBefore); // one key per process, as Bun's mount does
      await c.stop();
      await revived.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("the gate refuses before a socket exists: capacity is a 503 on the upgrade, and a close frees the seat", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-relay-node-"));
    try {
      const relay = await startRelay(0, {
        dataDir,
        keepaliveMs: 60_000,
        limits: { maxConnections: 1 },
      });
      const first = new WebSocket(relay.url);
      await new Promise((resolve) => first.addEventListener("open", resolve, { once: true }));

      const refused = await fetch(relay.url.replace("ws", "http"), {
        headers: { upgrade: "websocket", connection: "upgrade" },
      });
      expect(refused.status).toBe(503);
      // a plain request is not an upgrade, and says so rather than pretending to be refused
      expect((await fetch(relay.url.replace("ws", "http"))).status).toBe(426);

      first.close();
      await until(() => Promise.resolve(false), 80);
      const admitted = new WebSocket(relay.url);
      const opened = await new Promise((resolve) => {
        admitted.addEventListener("open", () => resolve(true), { once: true });
        admitted.addEventListener("error", () => resolve(false), { once: true });
      });
      expect(opened).toBe(true);
      admitted.close();
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a posture turns a stranger's origin away with 403", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-relay-node-"));
    try {
      const relay = await startRelay(0, {
        dataDir,
        keepaliveMs: 60_000,
        posture: { allowedOrigins: ["https://app.example"] },
      });
      const refused = await fetch(relay.url.replace("ws", "http"), {
        headers: { upgrade: "websocket", connection: "upgrade", origin: "https://evil.example" },
      });
      expect(refused.status).toBe(403);
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
