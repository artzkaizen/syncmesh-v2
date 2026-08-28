import type { RelayDial, RelayFrame } from "@syncmesh/relay";

import { createMesh } from "@syncmesh/client";
import { tableDigests } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import {
  decodeRelayFrame,
  joinFrame,
  relayTransport,
  startRelay,
  webSocketDial,
} from "@syncmesh/relay";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { durableRelay } from "./hosts.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  defineSchema({
    partitions: { org: {} },
    roles: { org: ["member"] },
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: "org",
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
type Dial = () => Promise<RelayDial> | RelayDial;

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

/** One device on a room, ungranted: the schema is the only check, which is all a host test needs. */
const device = async (dial: Dial, n: number) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [relayTransport({ dial, reconnectMs: 20 })],
    })
  ).unwrap();

/**
 * The scenario a phone runs against any host: two devices write into one room and each ends up
 * holding both writes. It answers with the state digests rather than the row counts, because
 * two peers can agree on how many rows they have and still disagree about what is in them.
 *
 * The writes are serialised — b only writes once it holds a's — so that the digests are the same
 * under every host. An HLC's logical counter moves when a remote event lands, so overlapping
 * writes stamp differently depending on which frame won a race, and comparing across hosts would
 * be comparing the timing rather than the room.
 */
const converge = async (dial: Dial) => {
  const a = await device(dial, 7);
  const b = await device(dial, 160);
  await Promise.all([a.ready(), b.ready()]);
  const ha = a.on("org:acme").unwrap();
  const hb = b.on("org:acme").unwrap();
  const count = (mesh: typeof ha) =>
    mesh.db
      .select()
      .from(notes)
      .then((r) => r.length);

  await ha.db.insert(notes).values({ id: "n1", body: "from a" });
  const arrived = await until(async () => (await count(hb)) === 1);
  await hb.db.insert(notes).values({ id: "n2", body: "from b" });
  const both =
    arrived && (await until(async () => (await count(ha)) === 2 && (await count(hb)) === 2));

  const digests = { a: tableDigests(a.engine.state()), b: tableDigests(b.engine.state()) };
  await a.stop();
  await b.stop();
  return { both, digests };
};

/** A raw client: join with empty cursors and keep what comes back — hellos and pages, undigested. */
const probe = async (dial: Dial, n: number) => {
  const dialed = await dial();
  const frames: RelayFrame[] = [];
  dialed.onFrame((bytes) => {
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isOk()) frames.push(decoded.value);
  });
  dialed.send(joinFrame([1], createIdentity(seed(n)).unwrap().peerId, new Map()));
  await until(() => Promise.resolve(frames.some((f) => f.kind === "hello")));
  dialed.close();
  const hello = frames.find((f) => f.kind === "hello");
  const events = frames.reduce((sum, f) => sum + (f.kind === "page" ? f.events.length : 0), 0);
  return { epoch: hello?.kind === "hello" ? hello.epoch : undefined, events };
};

describe("the same room under two hosts (D09, E25)", () => {
  test("a phone cannot tell an embedded relay from a Durable Object", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-do-host-"));
    const object = durableRelay(new Database(":memory:"), { keepaliveMs: 60_000, pageSize: 2 });
    const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000, pageSize: 2 });
    try {
      const embedded = await converge(webSocketDial(relay.url));
      const durable = await converge(() => object.dial());
      expect(embedded.both).toBe(true);
      expect(durable.both).toBe(true);
      // the same events folded by the same engine: the digests must be equal across hosts, and
      // a host that reordered or dropped one would show up here and nowhere in the row counts
      expect(durable.digests.a).toEqual(embedded.digests.a);
      expect(durable.digests.b).toEqual(embedded.digests.b);
      expect(durable.digests.a).toEqual(durable.digests.b);
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an eviction rebuilds every socket, not only the one that woke the object", async () => {
    const object = durableRelay(new Database(":memory:"), { keepaliveMs: 60_000 });
    const a = await device(() => object.dial(), 7);
    const b = await device(() => object.dial(), 160);
    await Promise.all([a.ready(), b.ready()]);
    const ha = a.on("org:acme").unwrap();
    const hb = b.on("org:acme").unwrap();
    const count = (mesh: typeof ha) =>
      mesh.db
        .select()
        .from(notes)
        .then((r) => r.length);

    await ha.db.insert(notes).values({ id: "n1", body: "before" });
    expect(await until(async () => (await count(hb)) === 1)).toBe(true);

    object.evict(); // the room, its client table and its presence tier are gone; the sockets are not

    // only a's socket carries the frame that wakes the object; b never sends anything
    await ha.db.insert(notes).values({ id: "n2", body: "after" });
    expect(await until(async () => (await count(hb)) === 2)).toBe(true);
    expect(tableDigests(b.engine.state())).toEqual(tableDigests(a.engine.state()));
    await a.stop();
    await b.stop();
  }, 30_000);

  test("the epoch is the object's, not the instance's: an eviction does not restart the lineage", async () => {
    const object = durableRelay(new Database(":memory:"), { keepaliveMs: 60_000 });
    const a = await device(() => object.dial(), 7);
    await a.ready();
    await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "kept" });
    expect(await until(async () => (await probe(() => object.dial(), 40)).events === 1)).toBe(true);

    const before = await probe(() => object.dial(), 41);
    object.evict();
    const after = await probe(() => object.dial(), 42);
    expect(after.epoch).toBe(before.epoch ?? "?");
    expect(after.events).toBe(1); // and the log the epoch describes is still there
    await a.stop();
  }, 30_000);
});
