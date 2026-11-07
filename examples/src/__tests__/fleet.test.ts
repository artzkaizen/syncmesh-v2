import type { Interest } from "@syncmesh/engine";
import type { Fanout, RelayFrame, RunningRelay } from "@syncmesh/relay";

import { createMesh } from "@syncmesh/client";
import { tableDigests } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import {
  RELAY_PROTOCOL_VERSIONS,
  decodeRelayFrame,
  isHello,
  joinFrame,
  memoryFanout,
  relayTransport,
  secureLink,
  startRelay,
  webSocketDial,
} from "@syncmesh/relay";
import { omitUndefined } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTANCE, ROOM, notes, notesSchema } from "../notes.js";

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(15);
  }
  return check();
};

/** The fan-out with a switch on it: what a Redis that loses a frame looks like from the relay. */
const lossyFanout = (inner: Fanout) => {
  let delivering = true;
  return {
    drop: () => void (delivering = false),
    fanout: {
      connect: (room: string) => {
        const link = inner.connect(room);
        return {
          ...link,
          publish: (frame: Uint8Array) => void (delivering && link.publish(frame)),
        };
      },
    } satisfies Fanout,
  };
};

/** A temp directory removed when `close` is called; one relay's log per directory. */
const scratch = () => {
  const dirs: string[] = [];
  return {
    dir: () => {
      const made = mkdtempSync(join(tmpdir(), "syncmesh-fleet-"));
      dirs.push(made);
      return made;
    },
    close: () => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    },
  };
};

/**
 * One phone on one instance, ungranted: the schema is the only check a host test needs. Given a
 * `file`, its state outlives the mesh — which is what lets the same phone come back on a different
 * instance, the way a load balancer with no sticky sessions makes it.
 */
const device = async (relay: RunningRelay, n: number, interest?: Interest, file?: string) =>
  (
    await createMesh({
      driver: bunSqliteDriver(file ?? ":memory:"),
      schema: notesSchema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [
        relayTransport({
          dial: webSocketDial(`${relay.url}/${ROOM}`),
          reconnectMs: 20,
          ...omitUndefined({ interest }),
        }),
      ],
    })
  ).unwrap();

/** How many notes this device holds, read the way the app reads them. */
const noteCount = async (mesh: Awaited<ReturnType<typeof device>>) =>
  (await mesh.on(INSTANCE).unwrap().db.select().from(notes)).length;

/**
 * The scenario a phone runs against any host: two devices write into one room and each ends up
 * holding both writes. It answers with the state digests rather than the row counts, because two
 * peers can agree on how many rows they have and still disagree about what is in them.
 *
 * The writes are serialised — b only writes once it holds a's — so the digests are the same under
 * every host. An HLC's logical counter moves when a remote event lands, so overlapping writes
 * stamp differently depending on which frame won a race, and comparing hosts would be comparing
 * the timing rather than the room.
 */
const converge = async (first: RunningRelay, second: RunningRelay) => {
  const a = await device(first, 7);
  const b = await device(second, 160);
  await Promise.all([a.ready(), b.ready()]);
  await a.on(INSTANCE).unwrap().db.insert(notes).values({ id: "n1", body: "from a", author: "a" });
  const arrived = await until(async () => (await noteCount(b)) === 1);
  await b.on(INSTANCE).unwrap().db.insert(notes).values({ id: "n2", body: "from b", author: "b" });
  const both =
    arrived && (await until(async () => (await noteCount(a)) === 2 && (await noteCount(b)) === 2));

  const digests = { a: tableDigests(a.engine.state()), b: tableDigests(b.engine.state()) };
  await a.stop();
  await b.stop();
  return { both, digests };
};

/** What one instance's own log holds, asked the way a fresh phone asks: answer the room's hello, join empty over the sealed link, count the pages (D36). */
const eventsInLog = async (relay: RunningRelay, n: number): Promise<number> => {
  const dialed = await webSocketDial(`${relay.url}/${ROOM}`)();
  const identity = createIdentity(seed(n)).unwrap();
  const link = secureLink(identity);
  const frames: RelayFrame[] = [];
  dialed.onFrame((bytes) => {
    if (link.session() === undefined) {
      if (!isHello(bytes)) return;
      link.receive(bytes).unwrap();
      if (link.hello !== undefined) dialed.send(link.hello);
      const join = link.seal(joinFrame([...RELAY_PROTOCOL_VERSIONS], identity.peerId, new Map()));
      if (join !== undefined) dialed.send(join);
      return;
    }
    const opened = link.receive(bytes);
    if (opened.isErr() || opened.value === undefined) return;
    const decoded = decodeRelayFrame(opened.value);
    if (decoded.isOk()) frames.push(decoded.value);
  });
  await until(() => Promise.resolve(frames.some((f) => f.kind === "page" && !f.more)));
  dialed.close();
  return frames.reduce((sum, f) => sum + (f.kind === "page" ? f.events.length : 0), 0);
};

describe("the Redis-fleet shape in one process: two relays, one fan-out (D09-B, E25)", () => {
  test("a phone cannot tell a fleet from a single relay: the digests match across the hosts", async () => {
    const dirs = scratch();
    // one fanout, two instances, a private log each — what the compose file deploys, minus the
    // containers. `memoryFanout` stands in for Redis because the port is what is under test, and
    // `redisFanout` is proved against a fake Redis in @syncmesh/relay's own suite.
    const fanout = memoryFanout();
    const alone = await startRelay(0, { dataDir: dirs.dir(), keepaliveMs: 60_000 });
    const one = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    const two = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    try {
      const single = await converge(alone, alone); // both phones on one box, shape A
      const fleet = await converge(one, two); // a phone per instance, shape B
      expect(single.both).toBe(true);
      expect(fleet.both).toBe(true);
      // across the transport seam and across the two hosts, not one engine against itself: the
      // same events folded by the same engine must digest identically, and an instance that
      // reordered or dropped one would show up here and nowhere in the row counts
      expect(fleet.digests.a).toEqual(single.digests.a);
      expect(fleet.digests.b).toEqual(single.digests.b);
      expect(fleet.digests.a).toEqual(fleet.digests.b);
    } finally {
      for (const relay of [alone, one, two]) await relay.stop();
      dirs.close();
    }
  }, 30_000);

  test("the instance that received the fan-out stored it too: either log serves a later phone", async () => {
    const dirs = scratch();
    const fanout = memoryFanout();
    const one = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    const two = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    try {
      const a = await device(one, 7);
      const b = await device(two, 160);
      await Promise.all([a.ready(), b.ready()]);
      await a
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "n1", body: "live", author: "a" });
      expect(await until(async () => (await noteCount(b)) === 1)).toBe(true);

      // API.md §13.5's word is "ingests", and it is what makes a fleet's durability each instance
      // rather than the union of them: a phone that lands on either box afterwards is paged the
      // same room, and either box could serve the next joiner alone.
      expect(await eventsInLog(one, 40)).toBe(1);
      expect(await eventsInLog(two, 41)).toBe(1);
      await a.stop();
      await b.stop();
    } finally {
      for (const relay of [one, two]) await relay.stop();
      dirs.close();
    }
  }, 30_000);

  test("a narrowed interest is honoured whichever instance the load balancer picked", async () => {
    const dirs = scratch();
    const fanout = memoryFanout();
    const one = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    const two = await startRelay(0, { dataDir: dirs.dir(), fanout, keepaliveMs: 60_000 });
    // an instance this room never writes to: a device asking only for it should hear nothing
    const elsewhere = { partitions: [parsePartitionKey("org:other").unwrap()] } satisfies Interest;
    try {
      const writer = await device(one, 7);
      const near = await device(one, 30, elsewhere); // narrowed, on the ingesting instance
      const far = await device(two, 60, elsewhere); // narrowed, on the forwarding one
      const witness = await device(two, 90); // unnarrowed, so the frame demonstrably crossed
      await Promise.all([writer.ready(), near.ready(), far.ready(), witness.ready()]);
      await writer
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "n1", body: "x", author: "a" });

      expect(await until(async () => (await noteCount(witness)) === 1)).toBe(true);
      expect(await noteCount(far)).toBe(0); // E25's done-when: the phone cannot tell which box
      expect(await noteCount(near)).toBe(0);
      for (const mesh of [writer, near, far, witness]) await mesh.stop();
    } finally {
      for (const relay of [one, two]) await relay.stop();
      dirs.close();
    }
  }, 30_000);

  /**
   * API.md §13.5's own test, and the sentence it is there to keep honest: "pub/sub is best-effort
   * and correctness never depends on it". It does not depend on it, but the recovery is not free
   * and it is not automatic — nothing re-requests a dropped frame, because neither instance knows
   * one existed. What puts it back is a device that holds the event landing on the starved
   * instance and pushing everything above the cursors it was greeted with. Round-robin without
   * sticky sessions is what makes that happen; a sticky fleet has to wait for a reconnect.
   */
  test("a frame the fan-out drops reaches the other instance when a phone that holds it lands there", async () => {
    const dirs = scratch();
    const link = lossyFanout(memoryFanout());
    const one = await startRelay(0, {
      dataDir: dirs.dir(),
      fanout: link.fanout,
      keepaliveMs: 60_000,
    });
    const two = await startRelay(0, {
      dataDir: dirs.dir(),
      fanout: link.fanout,
      keepaliveMs: 60_000,
    });
    const roaming = join(dirs.dir(), "roaming.db");
    try {
      link.drop();
      const a = await device(one, 7, undefined, roaming);
      const b = await device(two, 160);
      await Promise.all([a.ready(), b.ready()]);
      await a
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "n1", body: "dropped", author: "a" });
      expect(await until(async () => (await eventsInLog(one, 40)) === 1)).toBe(true);
      await Bun.sleep(200);
      expect(await eventsInLog(two, 41)).toBe(0); // the frame is gone, and nobody asks for it
      expect(await noteCount(b)).toBe(0);
      const stranded = tableDigests(a.engine.state());
      await a.stop();

      // the same phone, on the other instance: its join is the whole recovery
      const roamed = await device(two, 7, undefined, roaming);
      await roamed.ready();
      expect(await until(async () => (await noteCount(b)) === 1)).toBe(true);
      expect(await eventsInLog(two, 42)).toBe(1);
      expect(tableDigests(b.engine.state())).toEqual(stranded);
      await roamed.stop();
      await b.stop();
    } finally {
      for (const relay of [one, two]) await relay.stop();
      dirs.close();
    }
  }, 30_000);
});
