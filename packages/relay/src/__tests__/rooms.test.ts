import type { EventStore } from "@syncmesh/engine";

import { createMemoryEventStore } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayRoomOptions } from "../room.js";

import { webSocketDial } from "../dial.js";
import { joinFrame } from "../frames.js";
import { openRelayRoom } from "../room.js";
import { createRoomTable } from "../rooms.js";
import { startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { bodyOf, fakeSocket, mintFor, peer, secureProbe, tick, until, write } from "./fixtures.js";

const IDLE = Temporal.Duration.from({ milliseconds: 40 });

/**
 * A table over one shared log, counting how many times a room was opened and how many times its
 * borrowed handle came back — the two numbers an eviction is supposed to move.
 */
const tableOver = (store: EventStore, overrides: Partial<RelayRoomOptions> = {}) => {
  const counts = { opened: 0, released: 0 };
  const table = createRoomTable({
    open: async (name, grants) => {
      counts.opened += 1;
      const room = (
        await openRelayRoom({
          name,
          store,
          epoch: "epoch-1",
          keepaliveMs: 60_000,
          grants,
          versions: [1, 2], // this file scripts bare joins to get at eviction; the proof is join-proof.test's
          ...overrides,
        })
      ).unwrap();
      return { room, release: () => void (counts.released += 1) };
    },
    idleAfter: IDLE,
    now: () => Temporal.Now.instant(),
  });
  return { table, counts };
};

describe("idle-room eviction", () => {
  /** A `hello`'s epoch names the log's lineage; an unchanged log must not get a new one. */
  test("a caller-supplied store keeps one epoch across an eviction", async () => {
    const a = peer(40, "acct_a");
    const relay = await startRelay(0, {
      store: createMemoryEventStore(),
      idleAfter: IDLE,
      keepaliveMs: 60_000,
    });
    const epochOnJoin = async () => {
      // the room speaks first (D36): run its handshake, join over the sealed link, read the hello
      const probing = await secureProbe(webSocketDial(`${relay.url}/main`), a.identity);
      probing.join();
      await until(() => probing.ofKind("hello").length > 0, 2000);
      probing.close();
      return probing.ofKind("hello")[0]?.epoch;
    };
    try {
      const first = await epochOnJoin();
      await tick(120); // long enough for the idle sweep to close and release the room
      const second = await epochOnJoin();
      expect(first).toBeDefined();
      expect(second).toBe(first);
    } finally {
      await relay.stop();
    }
  }, 15_000);

  /**
   * The default host's `release` is `stores.close` over `relay-<name>.db`, so an open that does
   * not wait for it is two writers on one SQLite file — and the object that wins is whichever
   * finished last.
   */
  test("a re-open waits for the close of the object it replaces", async () => {
    const log: string[] = [];
    let opens = 0;
    const table = createRoomTable({
      open: async (name, grants) => {
        opens += 1;
        const n = opens;
        log.push(`open ${n}`);
        const room = (
          await openRelayRoom({
            name,
            store: createMemoryEventStore(),
            epoch: "epoch-1",
            keepaliveMs: 60_000,
            grants,
          })
        ).unwrap();
        return {
          room,
          release: async () => {
            log.push(`release start ${n}`);
            await tick(60);
            log.push(`release done ${n}`);
          },
        };
      },
      idleAfter: IDLE,
      now: () => Temporal.Now.instant(),
    });

    (await table.acquire("main")).release();
    expect(await until(() => table.count() === 0, 2000)).toBe(true);
    await table.acquire("main"); // the same name, while the first handle is still closing
    expect(await until(() => log.includes("open 2"), 2000)).toBe(true);
    expect(log).toEqual(["open 1", "release start 1", "release done 1", "open 2"]);
    await table.close();
  });

  test("a room nobody is on is closed and its log handle given back", async () => {
    const { table, counts } = tableOver(createMemoryEventStore());
    const held = await table.acquire("main");
    expect(table.count()).toBe(1);
    held.release();

    expect(await until(() => table.count() === 0, 2000)).toBe(true);
    await tick(30);
    expect(counts.released).toBe(1);
    expect(counts.opened).toBe(1);
    await table.close();
  });

  /**
   * The window this table exists to close. `clients()` is zero from the moment a socket is
   * accepted until its `join` frame lands, so a table that evicted on the room's own client count
   * would drop the room out from under a socket that is still being accepted.
   */
  test("a socket that has not joined yet still holds its room open", async () => {
    const { table } = tableOver(createMemoryEventStore());
    const held = await table.acquire("main");
    expect(held.room.clients()).toBe(0); // accepted, not joined
    await tick(140); // several eviction deadlines
    expect(table.count()).toBe(1);
    held.release();
    expect(await until(() => table.count() === 0, 2000)).toBe(true);
    await table.close();
  });

  test("release is idempotent: a host that calls it twice does not free a room somebody else holds", async () => {
    const { table } = tableOver(createMemoryEventStore());
    const first = await table.acquire("main");
    const second = await table.acquire("main");
    first.release();
    first.release();
    await tick(140);
    expect(table.count()).toBe(1); // `second` is still on it
    second.release();
    expect(await until(() => table.count() === 0, 2000)).toBe(true);
    await table.close();
  });

  /**
   * What an eviction must not take with it. A device sends its grants once, right after joining,
   * and never again — so a room re-opened with a fresh cache holds only the grants of whoever is
   * connected at that instant, and the next joiner is paged a catch-up it can validate nothing
   * of. That is exactly the bug the Durable Object host shipped.
   */
  test("the grant a departed device left survives the eviction and reaches the next joiner", async () => {
    const a = peer(40, "acct_a");
    const { table, counts } = tableOver(createMemoryEventStore());

    const first = await table.acquire("main");
    const sa = fakeSocket();
    const ca = first.room.connect(sa.socket);
    ca.receive(joinFrame([1], a.identity.peerId, new Map()));
    await tick();
    ca.receive(grantFrame(mintFor(a.identity, "acct_a")));
    await tick();
    ca.closed();
    first.release();

    expect(await until(() => table.count() === 0, 2000)).toBe(true);
    const second = await table.acquire("main");
    expect(counts.opened).toBe(2); // genuinely a different room object
    const late = fakeSocket();
    second.room
      .connect(late.socket)
      .receive(joinFrame([1], peer(80, "acct_b").identity.peerId, new Map()));
    await tick();
    expect(late.ofKind("page")[0]?.grants).toHaveLength(1);
    second.release();
    await table.close();
  });

  test("closing the table evicts what is left, however many sockets think they hold it", async () => {
    const { table, counts } = tableOver(createMemoryEventStore());
    await table.acquire("one");
    await table.acquire("two");
    expect(table.count()).toBe(2);
    await table.close();
    expect(table.count()).toBe(0);
    expect(counts.released).toBe(2);
  });

  test("without idleAfter a room is held for the life of the table", async () => {
    const counts = { opened: 0 };
    const table = createRoomTable({
      open: async (name, grants) => {
        counts.opened += 1;
        const room = (
          await openRelayRoom({
            name,
            grants,
            store: createMemoryEventStore(),
            epoch: "epoch-1",
            keepaliveMs: 60_000,
          })
        ).unwrap();
        return { room, release: () => undefined };
      },
      now: () => Temporal.Now.instant(),
    });
    (await table.acquire("main")).release();
    await tick(140);
    expect(table.count()).toBe(1);
    expect(counts.opened).toBe(1);
    await table.close();
  });
});

describe("startRelay, with idle rooms evicted", () => {
  test("a room evicted while empty re-opens over its own log and loses nothing", async () => {
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      store: createMemoryEventStore(),
      epoch: "epoch-1",
      idleAfter: IDLE,
    });
    try {
      const a = peer(40, "acct_a");
      const b = peer(80, "acct_b");
      await write(a, "n1", "one");
      await write(a, "n2", "two");

      const ta = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await ta.start(a.context);
      await ta.whenReady();
      await ta.caughtUp?.();
      await tick(80);
      await ta.stop();

      await tick(200); // long enough for the room to go idle and be evicted

      const tb = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await tb.start(b.context);
      expect(await until(() => bodyOf(b, "n2") === "two", 10_000)).toBe(true);
      await tb.stop();
    } finally {
      await relay.stop();
    }
  }, 30_000);
});
