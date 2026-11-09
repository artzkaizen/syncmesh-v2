import type { TelemetryEvent } from "@syncmesh/engine";
import type { SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { BlobLedger } from "@syncmesh/storage";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import {
  hashOf,
  memoryBlobHomes,
  memoryBlobLedger,
  memoryBlobStore,
  sqlBlobHomes,
  sqlBlobLedger,
  sqlBlobStore,
  sqliteEventStore,
} from "@syncmesh/storage";
import { Temporal, addToInstant } from "@syncmesh/temporal";
import { eventFrame } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import type { RelayRetention } from "../retention.js";

import { cappedBlobStore } from "../blob-cap.js";
import { createBlobKeeper } from "../blob-keeper.js";
import { blobGetFrame, blobPutFrame, joinFrame } from "../frames.js";
import {
  ACME,
  GLOBEX,
  T0,
  entryOf,
  fakeSocket,
  filled,
  peer,
  remove,
  scriptedRoom,
  tick,
  write,
} from "./fixtures.js";

const DAY = Temporal.Duration.from({ days: 1 });
const HOUR = Temporal.Duration.from({ hours: 1 });

/** A room on a clock the test moves, one joined socket on it, and the blob store underneath. */
const blobRoom = async (
  retention: RelayRetention,
  extra: Partial<Parameters<typeof scriptedRoom>[0]> = {},
  start = T0,
  /** Where the author's cursor stands: a reopened room that trimmed refuses a join below its floor. */
  at = 0,
) => {
  let clock = start;
  const blobs = extra?.blobs ?? memoryBlobStore();
  const room = await scriptedRoom({ blobs, retention, now: () => clock, ...extra });
  const author = peer(40, "acct_a");
  const s = fakeSocket();
  const conn = room.connect(s.socket);
  // SAFETY: a test's cursor, a non-negative integer by construction
  const cursors = new Map(at === 0 ? [] : [[author.identity.peerId, at as SeqNum]]);
  conn.receive(joinFrame([1], author.identity.peerId, cursors));
  await tick();
  return {
    room,
    blobs,
    author,
    s,
    conn,
    later: (by: Temporal.Duration) => void (clock = addToInstant(clock, by)),
    put: async (bytes: Uint8Array, partition = ACME) => {
      conn.receive(blobPutFrame(hashOf(bytes), bytes, partition));
      await tick();
    },
    get: async (bytes: Uint8Array) => {
      conn.receive(blobGetFrame(hashOf(bytes)));
      await tick();
    },
    /** A row whose cell carries the hash: the only reference a relay can see. */
    reference: async (bytes: Uint8Array, id: string) => {
      conn.receive(eventFrame(await write(author, id, hashOf(bytes))));
      await tick();
    },
    /** The author deletes the row: the relay sees the delete and nothing else about it. */
    unreference: async (id: string) => {
      conn.receive(eventFrame(await remove(author, id)));
      await tick();
    },
    /** Where the room's clock is now, for a room reopened after this one. */
    clock: () => clock,
  };
};

describe("the blob sweep (D18)", () => {
  test("an unreferenced blob past the window goes; a referenced or a young one stays", async () => {
    const r = await blobRoom({ keepUnreferencedBlobsFor: DAY });
    const orphan = filled(1, 16);
    const named = filled(2, 16);
    const young = filled(3, 16);
    await r.put(orphan);
    await r.put(named);
    await r.reference(named, "n1");

    r.later(DAY);
    await r.put(young);
    await r.room.sweep();

    expect(await r.blobs.has(hashOf(orphan))).toBe(false);
    expect(await r.blobs.has(hashOf(named))).toBe(true);
    expect(await r.blobs.has(hashOf(young))).toBe(true);
    r.room.close();
  });

  test("a swept hash is BlobNotFound, and a re-put under the same name brings it back", async () => {
    const r = await blobRoom({ keepUnreferencedBlobsFor: DAY });
    const photo = filled(7, 32);
    await r.put(photo);
    r.later(DAY);
    await r.room.sweep();

    const gone = await r.blobs.get(hashOf(photo));
    expect(gone.isErr() && gone.error._tag).toBe("BlobNotFound");
    await r.get(photo);
    expect(r.s.ofKind("blob-missing").map((f) => f.hash)).toEqual([hashOf(photo)]);

    // anyone still holding the bytes can put them back, because the name is the content
    await r.put(photo);
    await r.get(photo);
    expect(r.s.ofKind("blob").map((f) => f.hash)).toEqual([hashOf(photo)]);
    expect(r.s.ofKind("blob-stored")).toHaveLength(2);
    r.room.close();
  });

  test("a reference outlives the log trimming the event that made it: the row is still live", async () => {
    // a row inserted once and never written again exists on every device after its event is
    // trimmed, and the relay is its blob's durable home (D18), so the trim must free nothing
    const r = await blobRoom({ keepEventsFor: HOUR, keepUnreferencedBlobsFor: DAY });
    const photo = filled(5, 16);
    await r.put(photo);
    await r.reference(photo, "n1");

    r.later(HOUR);
    await r.room.sweep(); // samples the ceiling the event sits under
    r.later(DAY);
    await r.room.sweep(); // trims that event
    expect(Number(r.room.floor().get(r.author.identity.peerId))).toBe(1);

    r.later(DAY);
    await r.room.sweep();
    r.later(DAY);
    await r.room.sweep();
    expect(await r.blobs.has(hashOf(photo))).toBe(true);
    r.room.close();
  });

  test("bytes put again that an earlier run left on disk are kept and cost no budget", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const photo = filled(6, 32);
    // an earlier run stored these, and the event that named them is no longer in the log
    (await store.putAt(hashOf(photo), photo)).unwrap();
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: 16,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    (await keeper.put(hashOf(photo), photo, ACME)).unwrap();
    clock = addToInstant(clock, DAY);
    expect((await keeper.sweep()).swept).toBe(0);
    expect(await store.has(hashOf(photo))).toBe(true);
  });

  test("a blob whose delete fails stays held and billed, is counted, and goes on the next pass", async () => {
    let clock = T0;
    let failing = true;
    const inner = memoryBlobStore();
    const store = {
      ...inner,
      delete: (hash: Parameters<typeof inner.delete>[0]) =>
        failing ? Promise.reject(new Error("disk busy")) : inner.delete(hash),
    };
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: 8,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    const [a, b] = [filled(1, 8), filled(2, 8)];
    (await keeper.put(hashOf(a), a, ACME)).unwrap();
    clock = addToInstant(clock, DAY);
    expect(await keeper.sweep()).toMatchObject({ swept: 0, failed: 1, held: 1, heldBytes: 8 });
    expect(await store.has(hashOf(a))).toBe(true);
    // still billed: the budget is as full as the disk is
    expect((await keeper.put(hashOf(b), b, ACME)).isErr()).toBe(true);
    failing = false;
    expect(await keeper.sweep()).toMatchObject({ swept: 1, failed: 0, held: 0 });
    expect(await store.has(hashOf(a))).toBe(false);
  });

  test("a sealed event keeps the blobs of its partition and of none; another partition's still go", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: undefined,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    const [mine, unpinned, theirs] = [filled(9, 8), filled(10, 8), filled(11, 8)];
    (await keeper.put(hashOf(mine), mine, ACME)).unwrap();
    (await keeper.put(hashOf(unpinned), unpinned, undefined)).unwrap();
    (await keeper.put(hashOf(theirs), theirs, GLOBEX)).unwrap();
    const plain = entryOf(await write(peer(41, "acct_b"), "s1", "anything", ACME)).event;
    keeper.note({ ...plain, changes: [], sealed: true } satisfies SyncEvent);
    clock = addToInstant(clock, DAY);
    const report = await keeper.sweep();
    expect(report).toEqual({
      swept: 1,
      sweptBytes: 8,
      held: 2,
      heldBytes: 16,
      referenced: 0,
      sealed: 2,
      failed: 0,
    });
    expect(await store.has(hashOf(mine))).toBe(true);
    expect(await store.has(hashOf(unpinned))).toBe(true);
    expect(await store.has(hashOf(theirs))).toBe(false);
  });

  test("a sealed event in no partition keeps every blob", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: undefined,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    const photo = filled(12, 8);
    (await keeper.put(hashOf(photo), photo, GLOBEX)).unwrap();
    const plain = entryOf(await write(peer(41, "acct_b"), "s1", "anything")).event;
    const { partition: _, ...unpartitioned } = plain;
    keeper.note({ ...unpartitioned, changes: [], sealed: true } satisfies SyncEvent);
    clock = addToInstant(clock, DAY);
    expect((await keeper.sweep()).swept).toBe(0);
    expect(await store.has(hashOf(photo))).toBe(true);
  });

  test("a reference is a hash-shaped string at any depth of a cell", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: undefined,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    const photo = filled(4, 8);
    const hash = hashOf(photo);
    (await keeper.put(hash, photo, undefined)).unwrap();
    const plain = entryOf(await write(peer(42, "acct_c"), "j1", "x")).event;
    const first = plain.changes[0];
    if (first?.kind !== "insert") throw new Error("the fixture write is an insert");
    const column = [...first.row.keys()].at(-1);
    if (column === undefined) throw new Error("the fixture row has columns");
    const nested = new Map(first.row);
    nested.set(column, { album: [{ cover: hash }] });
    keeper.note({ ...plain, changes: [{ ...first, row: nested }] });
    clock = addToInstant(clock, DAY);
    expect((await keeper.sweep()).swept).toBe(0);
    expect(await store.has(hash)).toBe(true);
  });
});

describe("a room that keeps no blobs", () => {
  test("answers a put with `no-store` at once, rather than leaving the putter to wait", async () => {
    const room = await scriptedRoom();
    const s = fakeSocket();
    const conn = room.connect(s.socket);
    conn.receive(joinFrame([1], peer(43, "acct_d").identity.peerId, new Map()));
    await tick();
    const photo = filled(8, 16);
    conn.receive(blobPutFrame(hashOf(photo), photo, ACME));
    await tick();
    expect(s.ofKind("blob-refused")).toEqual([
      { kind: "blob-refused", hash: hashOf(photo), code: "no-store", limit: 0, used: 0 },
    ]);
    expect(s.ofKind("blob-stored")).toEqual([]);
    expect(s.closedWith).toEqual([]);
    room.close();
  });
});

describe("per-partition blob quotas (D18)", () => {
  test("a put past its partition's quota is refused as a value and stores nothing", async () => {
    const r = await blobRoom({ maxBlobBytesPerPartition: 40 });
    const first = filled(1, 30);
    const second = filled(2, 20);
    await r.put(first);
    await r.put(second);

    const [refused] = r.s.ofKind("blob-refused");
    expect(refused).toEqual({
      kind: "blob-refused",
      hash: hashOf(second),
      code: "quota",
      limit: 40,
      used: 30,
      partition: ACME,
    });
    expect(await r.blobs.has(hashOf(second))).toBe(false);
    // a refusal is an answer, not a hang-up: the socket is still the putter's
    expect(r.s.ofKind("error")).toEqual([]);
    expect(r.s.closedWith).toEqual([]);

    // another partition has its own budget
    await r.put(second, GLOBEX);
    expect(await r.blobs.has(hashOf(second))).toBe(true);
    // and bytes already held are stored once and billed once, even into a full partition
    await r.put(first);
    expect(r.s.ofKind("blob-stored").map((f) => f.hash)).toEqual([
      hashOf(first),
      hashOf(second),
      hashOf(first),
    ]);
    r.room.close();
  });

  test("a blob the byte ceiling evicts mid-put gives its partition its bytes back", async () => {
    // the ceiling unbills through `forget` while the put that pushed it over is still awaiting the
    // store; the put must add its own bytes to what is billed now, not to what it read before
    let clock = T0;
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store: cappedBlobStore(memoryBlobStore(), 5, (hash) => keeper.forget(hash)),
      quota: 8,
      keepUnreferencedFor: undefined,
      now: () => clock,
    });
    const [a, b, c] = [filled(1, 4), filled(2, 4), filled(3, 4)];
    (await keeper.put(hashOf(a), a, ACME)).unwrap();
    (await keeper.put(hashOf(b), b, ACME)).unwrap(); // evicts a: only b's 4 bytes are held
    clock = addToInstant(clock, HOUR);
    expect((await keeper.put(hashOf(c), c, ACME)).isOk()).toBe(true);
  });

  test("the same bytes put twice at once are billed once", async () => {
    // both puts read the blob as new before either stores it; the second to land must find the
    // first one's bill rather than add its own
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store: memoryBlobStore(),
      quota: 12,
      keepUnreferencedFor: undefined,
      now: () => T0,
    });
    const [a, b] = [filled(1, 6), filled(2, 6)];
    const twice = await Promise.all([
      keeper.put(hashOf(a), a, ACME),
      keeper.put(hashOf(a), a, ACME),
    ]);
    expect(twice.every((put) => put.isOk())).toBe(true);
    expect((await keeper.put(hashOf(b), b, ACME)).isOk()).toBe(true);
  });

  test("a swept blob gives its partition its bytes back", async () => {
    const r = await blobRoom({ maxBlobBytesPerPartition: 40, keepUnreferencedBlobsFor: DAY });
    await r.put(filled(1, 30));
    r.later(DAY);
    await r.room.sweep();
    await r.put(filled(2, 30));
    expect(r.s.ofKind("blob-refused")).toEqual([]);
    r.room.close();
  });
});

describe("references follow rows, across trims and restarts (gaps U18)", () => {
  test("deleting the row frees its blob a window after the delete, not before", async () => {
    const r = await blobRoom({ keepUnreferencedBlobsFor: DAY });
    const photo = filled(13, 16);
    await r.put(photo);
    await r.reference(photo, "n1");
    r.later(DAY);
    await r.room.sweep();
    expect(await r.blobs.has(hashOf(photo))).toBe(true); // a live row names it

    await r.unreference("n1");
    r.later(HOUR);
    await r.room.sweep();
    // a day since its put, an hour since its delete: an offline write may still bring the row back
    expect(await r.blobs.has(hashOf(photo))).toBe(true);
    r.later(DAY);
    await r.room.sweep();
    expect(await r.blobs.has(hashOf(photo))).toBe(false);
    r.room.close();
  });

  test("a delete stamped before the row's latest write frees nothing, whatever order they arrive in", async () => {
    const r = await blobRoom({ keepUnreferencedBlobsFor: DAY });
    const photo = filled(14, 16);
    await r.put(photo);
    await r.reference(photo, "n1"); // stamped at the author's clock, which starts at 100
    const early = peer(44, "acct_e", 10); // a clock behind the author's: its delete is older
    r.conn.receive(eventFrame(await remove(early, "n1")));
    await tick();
    r.later(DAY);
    r.later(DAY);
    await r.room.sweep();
    expect(await r.blobs.has(hashOf(photo))).toBe(true);
    r.room.close();
  });

  test("a reopened room keeps what a trimmed insert named, and bills and sweeps what an earlier run left", async () => {
    const driver = bunSqliteDriver(":memory:");
    const durable = async () => ({
      store: (await sqliteEventStore(driver)).unwrap(),
      blobs: (await sqlBlobStore(driver)).unwrap(),
      blobHomes: (await sqlBlobHomes(driver)).unwrap(),
      blobLedger: (await sqlBlobLedger(driver)).unwrap(),
    });
    const retention = {
      keepEventsFor: HOUR,
      keepUnreferencedBlobsFor: DAY,
      maxBlobBytesPerPartition: 40,
    };
    const first = await blobRoom(retention, await durable());
    const [photo, orphan, more] = [filled(15, 16), filled(16, 16), filled(17, 16)];
    await first.put(photo);
    await first.reference(photo, "n1");
    first.later(HOUR);
    await first.room.sweep(); // samples the ceiling the insert sits under
    first.later(HOUR);
    await first.room.sweep(); // trims the insert: only the ledger remembers what it named
    expect(Number(first.room.floor().get(first.author.identity.peerId))).toBe(1);
    await first.put(orphan); // an upload whose row never arrives, left on disk at close
    first.room.close();

    const second = await blobRoom(retention, await durable(), first.clock(), 1);
    // the earlier run's 32 bytes are on ACME's budget: 16 more would pass its 40
    await second.put(more);
    expect(second.s.ofKind("blob-refused").map((f) => f.code)).toEqual(["quota"]);
    second.later(DAY);
    await second.room.sweep();
    expect(await second.blobs.has(hashOf(photo))).toBe(true); // the trimmed insert's row is live
    expect(await second.blobs.has(hashOf(orphan))).toBe(false); // a day since the room opened
    second.room.close();
  });

  test("a room that reopens more often than the window still sweeps: the window is saved, not restarted", async () => {
    const driver = bunSqliteDriver(":memory:");
    const durable = async () => ({
      store: (await sqliteEventStore(driver)).unwrap(),
      blobs: (await sqlBlobStore(driver)).unwrap(),
      blobHomes: (await sqlBlobHomes(driver)).unwrap(),
      blobLedger: (await sqlBlobLedger(driver)).unwrap(),
    });
    const retention = { keepUnreferencedBlobsFor: DAY };
    const orphan = filled(23, 16); // an upload whose row never arrives
    const [photo, kept] = [filled(24, 16), filled(25, 16)];
    const twentyHours = Temporal.Duration.from({ hours: 20 });
    let clock = T0;
    const present: boolean[] = [];
    for (let run = 0; run < 3; run += 1) {
      const r = await blobRoom(retention, await durable(), clock);
      if (run === 0) {
        await r.put(orphan);
        await r.put(photo);
        await r.reference(photo, "n1");
        await r.unreference("n1"); // released in this run, and saved by its first pass
        await r.put(kept);
        await r.reference(kept, "n2");
      }
      r.later(HOUR);
      await r.room.sweep();
      present.push(await r.blobs.has(hashOf(orphan)), await r.blobs.has(hashOf(photo)));
      r.later(twentyHours);
      clock = r.clock();
      expect(await r.blobs.has(hashOf(kept))).toBe(true); // a live row still names it
      r.room.close();
    }
    // 1 h, 22 h and 43 h after the put and the delete: gone a day after them, whatever the reopens
    expect(present).toEqual([true, true, true, true, false, false]);
  });

  test("a room whose log was trimmed before it had a ledger keeps an earlier run's blobs", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const photo = filled(18, 8);
    (await store.putAt(hashOf(photo), photo)).unwrap();
    const ledger: BlobLedger = {
      ...memoryBlobLedger(),
      stored: () => Promise.resolve(Result.ok(new Map([[hashOf(photo), photo.byteLength]]))),
    };
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: undefined,
      keepUnreferencedFor: DAY,
      now: () => clock,
      ledger,
      trimmedBefore: true,
    });
    (await keeper.open([])).unwrap();
    clock = addToInstant(clock, DAY);
    expect(await keeper.sweep()).toEqual({
      swept: 0,
      sweptBytes: 0,
      held: 0,
      heldBytes: 0,
      referenced: 0,
      sealed: 0,
      failed: 0,
    });
    expect(await store.has(hashOf(photo))).toBe(true);
  });

  test("a trim waits for the ledger: one that cannot save holds the floor where it was", async () => {
    const failing: BlobLedger = {
      ...memoryBlobLedger(),
      save: () => Promise.resolve(Result.err(new StoreFailure({ message: "disk full" }))),
    };
    const r = await blobRoom({ keepEventsFor: HOUR }, { blobLedger: failing });
    await r.reference(filled(19, 8), "n1");
    r.later(HOUR);
    await r.room.sweep();
    r.later(HOUR);
    await r.room.sweep();
    expect(r.room.floor().size).toBe(0);
    r.room.close();
  });

  test("every pass says what the sweep did, in counts and bytes (relay.blob.sweep)", async () => {
    const seen: TelemetryEvent[] = [];
    const r = await blobRoom(
      { keepUnreferencedBlobsFor: DAY },
      { onTelemetry: (event) => void seen.push(event) },
    );
    const [kept, gone] = [filled(20, 16), filled(21, 8)];
    await r.put(kept);
    await r.reference(kept, "n1");
    await r.put(gone);
    r.later(DAY);
    await r.room.sweep();
    const sweeps = seen.filter((event) => event.type === "relay.blob.sweep");
    expect(sweeps.map((event) => event.sizes)).toEqual([
      { swept: 1, sweptBytes: 8, held: 1, heldBytes: 16, referenced: 1, sealed: 0, failed: 0 },
    ]);
    r.room.close();
  });
});
