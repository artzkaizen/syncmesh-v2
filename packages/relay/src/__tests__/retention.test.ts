import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { createMemoryEventStore, tableDigests } from "@syncmesh/engine";
import { hashOf, memoryBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { eventFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayRoomOptions } from "../room.js";

import { cappedBlobStore } from "../blob-cap.js";
import { webSocketDial } from "../dial.js";
import { blobGetFrame, blobPutFrame, joinFrame } from "../frames.js";
import { startRelay } from "../serve.js";
import { relayTransport } from "../transport.js";
import { bodyOf, entryOf, fakeSocket, scriptedRoom, peer, tick, until, write } from "./fixtures.js";

const MS = (n: number) => Temporal.Duration.from({ milliseconds: n });
const KEEP_MS = 1000;
const KEEP = MS(KEEP_MS);
/** One step of the window, past which a sweep records a fresh mark. See `trackAdmissions`. */
const STEP_MS = KEEP_MS / 8;
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const at = (ms: number) => T0.add(MS(ms));

/**
 * A room whose clock the test drives, over a log seeded with `seeded` of one author's four events;
 * the rest arrive through a socket, which is what makes them younger than the seeded ones.
 *
 * Retention here is measured from **arrival**, so a fixture that only writes stamps proves
 * nothing: every event these peers author is stamped in 1970 whatever order it reaches the room in.
 */
const fourEvents = async (seeded: number, overrides: Partial<RelayRoomOptions> = {}) => {
  const a = peer(40, "acct_a");
  const wires = [
    await write(a, "n1", "one"),
    await write(a, "n2", "two"),
    await write(a, "n3", "three"),
    await write(a, "n4", "four"),
  ];
  const store = createMemoryEventStore();
  for (const wire of wires.slice(0, seeded)) (await store.append(entryOf(wire))).unwrap();
  let clock = T0;
  const room = await scriptedRoom({
    store,
    retention: { keepEventsFor: KEEP },
    now: () => clock,
    ...overrides,
  });
  // the rest arrive the way traffic does, after the room has already marked what it booted with
  const s = fakeSocket();
  const conn = room.connect(s.socket);
  conn.receive(joinFrame([1], a.identity.peerId, new Map()));
  await tick();
  for (const wire of wires.slice(seeded)) conn.receive(eventFrame(wire));
  await tick();
  return { a, store, room, tick: (to: Temporal.Instant) => void (clock = to) };
};

const joinAt = (room: Awaited<ReturnType<typeof scriptedRoom>>, who: PeerId, seq: number) => {
  const s = fakeSocket();
  /* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- a test cursor */
  const cursors = seq === 0 ? new Map<PeerId, SeqNum>() : new Map([[who, seq as SeqNum]]);
  room.connect(s.socket).receive(joinFrame([1], who, cursors));
  return s;
};

describe("the room-log retention cap", () => {
  test("a sweep trims what has been here longest, and the advertised floor moves with it", async () => {
    const { a, store, room, tick: setClock } = await fourEvents(2);

    expect([...room.floor()]).toEqual([]); // nothing trimmed yet
    setClock(at(KEEP_MS + STEP_MS));
    await room.sweep();

    // the two the room opened over have been here a full window; the two that arrived after it
    // belong to a mark that has not aged in yet
    expect(Number(room.floor().get(a.identity.peerId))).toBe(2);
    const held = (await store.all()).unwrap();
    expect(held.map((e) => Number(e.event.seqNum))).toEqual([3, 4]);

    // the ceiling is unchanged: the room still holds a contiguous run up to 4
    const s = joinAt(room, peer(200, "acct_j").identity.peerId, 0);
    await tick();
    expect(s.ofKind("error")[0]?.code).toBe("retention"); // that joiner is below the floor

    const above = joinAt(room, a.identity.peerId, 2);
    await tick();
    const hello = above.ofKind("hello")[0];
    expect(Number(hello?.cursors.get(a.identity.peerId))).toBe(4);
    expect(Number(hello?.floor.get(a.identity.peerId))).toBe(2);
    room.close();
  });

  /**
   * The convergence half, and the reason this cut is not one comparison against `hlc_ms`. An
   * event written offline, or by a device whose clock runs behind, is already older than the
   * window when it arrives. Trimmed on that stamp it is gone from the room in the next pass —
   * while `hello` still advertises it in the room's cursors, so its author never re-pushes it and
   * every peer that needs it is refused at the floor. Nobody would ever hold it again.
   */
  test("an event stamped long before it arrived is kept for the window it was actually here", async () => {
    const { a, store, room, tick: setClock } = await fourEvents(0);
    const stamp = (await store.all()).unwrap()[0]?.event.hlc[0];
    // the premise: every one of these is stamped decades before the room's own clock
    expect(Temporal.Instant.compare(stamp ?? T0, T0.subtract(KEEP))).toBeLessThan(0);

    setClock(at(KEEP_MS - 1));
    await room.sweep();
    expect([...room.floor()]).toEqual([]);
    expect((await store.all()).unwrap()).toHaveLength(4);

    // and a peer that has never been here is still served the whole run
    const s = joinAt(room, peer(200, "acct_j").identity.peerId, 0);
    await tick();
    expect(s.ofKind("error")).toEqual([]);
    expect(s.ofKind("page").flatMap((p) => p.events)).toHaveLength(4);
    expect(Number(s.ofKind("hello")[0]?.cursors.get(a.identity.peerId))).toBe(4);
    room.close();
  });

  test("what the cursor claims and what catch-up serves are the same set, after a trim as before", async () => {
    const { a, room, tick: setClock } = await fourEvents(2, { pageSize: 10 });
    setClock(at(KEEP_MS + STEP_MS));
    await room.sweep();

    // a client sitting exactly on the floor: everything above its cursor, and no gap
    const s = joinAt(room, a.identity.peerId, 2);
    await tick();
    const served = s
      .ofKind("page")
      .flatMap((page) => page.events)
      .map((wire) => Number(entryOf(wire).event.seqNum));
    expect(served).toEqual([3, 4]);
    const hello = s.ofKind("hello")[0];
    const floor = Number(hello?.floor.get(a.identity.peerId));
    const ceiling = Number(hello?.cursors.get(a.identity.peerId));
    expect(served).toEqual([floor + 1, ceiling]); // the advertised pair, exactly
    room.close();
  });

  test("a joiner below the floor is refused and closed, never registered and never paged", async () => {
    const { room, tick: setClock } = await fourEvents(2);
    setClock(at(KEEP_MS + STEP_MS));
    await room.sweep();

    const s = joinAt(room, peer(200, "acct_j").identity.peerId, 0);
    await tick();
    expect(s.ofKind("error")[0]?.code).toBe("retention");
    expect(s.closedWith).toEqual(["retention"]);
    expect(s.ofKind("page")).toEqual([]); // no page with the bottom missing
    expect(s.ofKind("hello")).toEqual([]);
    expect(room.clients()).toBe(1); // the author that fed it, and nobody else
    room.close();
  });

  /**
   * The same refusal, one queue slot later. A sweep and a catch-up run on the same room queue and
   * the floor only moves when the sweep resolves, so a join that lands mid-pass reads the floor
   * from before it — is greeted, and would then be paged the run the sweep just took the bottom
   * out of. The check inside the queue is what makes the greeting harmless.
   */
  test("a join that lands while a sweep is in flight is refused, never paged a hole", async () => {
    const { room, tick: setClock } = await fourEvents(2);
    setClock(at(KEEP_MS + STEP_MS));
    const sweeping = room.sweep(); // started, deliberately not awaited

    const s = joinAt(room, peer(200, "acct_j").identity.peerId, 0);
    await sweeping;
    await tick();

    expect(s.ofKind("page")).toEqual([]);
    expect(s.ofKind("error")[0]?.code).toBe("retention");
    expect(s.closedWith).toEqual(["retention"]);
    room.close();
  });

  /**
   * The boot half of the same invariant. A room re-opened over a trimmed log walks entries whose
   * run starts above zero; seeded from nothing, every one of them would look like an event past a
   * gap and the room would advertise a cursor of nothing at all — telling a caught-up client to
   * re-push its whole history, and telling a joiner it holds a log it holds.
   */
  test("a re-open over a trimmed log advertises the same pair the trim left behind", async () => {
    const { a, store, room, tick: setClock } = await fourEvents(2);
    setClock(at(KEEP_MS + STEP_MS));
    await room.sweep();
    room.close();

    const revived = await scriptedRoom({ store });
    const s = joinAt(revived, a.identity.peerId, 2);
    await tick();
    const hello = s.ofKind("hello")[0];
    expect(Number(hello?.cursors.get(a.identity.peerId))).toBe(4);
    expect(Number(hello?.floor.get(a.identity.peerId))).toBe(2);
    expect([...revived.floor()].map(([, seq]) => Number(seq))).toEqual([2]);
    revived.close();
  });

  test("a room with no retention set trims nothing and advertises an empty floor", async () => {
    const a = peer(40, "acct_a");
    const store = createMemoryEventStore();
    for (const id of ["n1", "n2", "n3", "n4"])
      (await store.append(entryOf(await write(a, id, id)))).unwrap();
    const room = await scriptedRoom({ store });
    await room.sweep();
    expect((await store.all()).unwrap()).toHaveLength(4);
    const s = joinAt(room, peer(200, "acct_j").identity.peerId, 0);
    await tick();
    expect([...(s.ofKind("hello")[0]?.floor ?? [])]).toEqual([]);
    expect(Number(s.ofKind("hello")[0]?.cursors.get(a.identity.peerId))).toBe(4);
    room.close();
  });

  /**
   * A calendar duration is the natural way to write a retention window, and every arithmetic step
   * has to take one: `Instant.subtract` refuses days outright and `Duration.total` refuses weeks,
   * and both failures land inside a queue that swallows them — a cap that silently never runs.
   */
  test("a window written in weeks sweeps like any other, rather than failing in silence", async () => {
    const {
      room,
      store,
      tick: setClock,
    } = await fourEvents(2, {
      retention: { keepEventsFor: Temporal.Duration.from({ weeks: 1 }) },
    });
    setClock(T0.add(MS(8 * 86_400_000))); // a week and a day
    await room.sweep();
    expect((await store.all()).unwrap().map((e) => Number(e.event.seqNum))).toEqual([3, 4]);
    room.close();
  });
});

describe("the blob retention cap", () => {
  const bytes = (n: number, size: number) => Uint8Array.from({ length: size }, () => n);

  test("the least recently touched bytes go first, and a fetch is a touch", async () => {
    const inner = memoryBlobStore();
    const capped = cappedBlobStore(inner, 30);
    const first = (await capped.put(bytes(1, 10))).unwrap();
    const second = (await capped.put(bytes(2, 10))).unwrap();
    (await capped.get(first)).unwrap(); // first is now the young end
    const third = (await capped.put(bytes(3, 10))).unwrap();
    expect(await inner.has(second)).toBe(true); // still under the cap: nothing evicted yet

    const fourth = (await capped.put(bytes(4, 10))).unwrap();
    expect(await inner.has(second)).toBe(false); // the oldest touch, and the one dropped
    expect(await inner.has(first)).toBe(true);
    expect(await inner.has(third)).toBe(true);
    expect(await inner.has(fourth)).toBe(true);
  });

  test("bytes the room evicted come back under the same name when anyone puts them again", async () => {
    const inner = memoryBlobStore();
    const capped = cappedBlobStore(inner, 10);
    const gone = (await capped.put(bytes(1, 10))).unwrap();
    (await capped.put(bytes(2, 10))).unwrap();
    expect((await capped.get(gone)).isErr()).toBe(true);
    (await capped.putAt(gone, bytes(1, 10))).unwrap();
    expect((await capped.get(gone)).unwrap()).toEqual(bytes(1, 10));
  });

  /**
   * The eviction loop yields between deletes. A fetch landing in that window finds bytes the inner
   * store has not dropped yet, and counting it as a touch would leave the cap holding a hash it
   * can never serve — under its own ceiling for as long as that entry sat there.
   */
  test("a fetch that races an eviction does not put the evicted hash back in the ledger", async () => {
    const inner = memoryBlobStore();
    let racing: (() => Promise<void>) | undefined;
    const slow = {
      ...inner,
      delete: async (hash: Parameters<typeof inner.delete>[0]) => {
        const during = racing;
        racing = undefined;
        if (during !== undefined) await during();
        await inner.delete(hash);
      },
    };
    const capped = cappedBlobStore(slow, 20);
    const first = (await capped.put(bytes(1, 10))).unwrap();
    const second = (await capped.put(bytes(2, 10))).unwrap();
    racing = async () => void (await capped.get(first)); // a reader, mid-delete
    const third = (await capped.put(bytes(3, 10))).unwrap();
    expect(await inner.has(first)).toBe(false); // it really went

    // the cap now holds exactly `second` and `third`, which is exactly its ceiling. A phantom
    // `first` in the ledger would make this put evict two blobs instead of one.
    const fourth = (await capped.put(bytes(4, 10))).unwrap();
    expect(await inner.has(third)).toBe(true);
    expect(await inner.has(fourth)).toBe(true);
    expect(await inner.has(second)).toBe(false); // the oldest touch, and the only one dropped
  });

  test("a blob bigger than the whole cap is kept: `putAt` must not answer ok for bytes it dropped", async () => {
    const inner = memoryBlobStore();
    const capped = cappedBlobStore(inner, 10);
    const big = (await capped.put(bytes(9, 40))).unwrap();
    expect((await capped.get(big)).unwrap()).toHaveLength(40);
  });

  test("a room serves its cap through the ordinary blob frames", async () => {
    const a = peer(40, "acct_a");
    const room = await scriptedRoom({
      blobs: memoryBlobStore(),
      retention: { maxBlobBytes: 8 },
    });
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(joinFrame([1], a.identity.peerId, new Map()));
    await tick();
    const one = bytes(1, 8);
    const two = bytes(2, 8);
    conn.receive(blobPutFrame(hashOf(one), one));
    await tick();
    conn.receive(blobPutFrame(hashOf(two), two));
    await tick();
    conn.receive(blobGetFrame(hashOf(one)));
    await tick();
    expect(s.ofKind("blob-missing").map((f) => f.hash)).toEqual([hashOf(one)]);
    conn.receive(blobGetFrame(hashOf(two)));
    await tick();
    expect(s.ofKind("blob").map((f) => f.hash)).toEqual([hashOf(two)]);
    room.close();
  });
});

/**
 * The convergence question. Retention is not a verdict — nothing about it reaches a row, and no
 * peer folds it — so the only way it could diverge two honest peers is by taking away history one
 * of them still needed. It cannot, because what a sweep takes is measured from when the room
 * admitted it, and because the relay refuses a client below the floor rather than paging it a run
 * with the bottom missing; a peer that was served at all was served a contiguous run. Digests,
 * across two engines through a real socket, because comparing rows on one engine is what let six
 * earlier convergence bugs ship green.
 */
describe("a trimmed room diverges nobody", () => {
  test("two peers converge, the room throws the whole log away, and they still fingerprint alike", async () => {
    const store = createMemoryEventStore();
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      store,
      epoch: "epoch-1",
      // short enough that a sweep empties the log while both peers are still on their sockets
      retention: { keepEventsFor: MS(200), sweepEvery: MS(20) },
    });
    try {
      const a = peer(40, "acct_a");
      const b = peer(80, "acct_b");
      for (let i = 1; i <= 6; i += 1) await write(a, `n${i}`, `body-${i}`);

      const ta = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      const tb = relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
      await ta.start(a.context);
      await tb.start(b.context);
      expect(await until(() => bodyOf(b, "n6") === "body-6", 10_000)).toBe(true);

      let emptied = false;
      for (let i = 0; i < 400 && !emptied; i += 1) {
        emptied = (await store.all()).unwrap().length === 0;
        if (!emptied) await tick(25);
      }
      expect(emptied).toBe(true); // the sweep really did take the whole log
      await write(a, "n7", "body-7"); // and the room still forwards what comes after the trim
      expect(await until(() => bodyOf(b, "n7") === "body-7", 10_000)).toBe(true);

      expect([...tableDigests(b.engine.state())]).toEqual([...tableDigests(a.engine.state())]);
      await ta.stop();
      await tb.stop();
    } finally {
      await relay.stop();
    }
  }, 30_000);
});
