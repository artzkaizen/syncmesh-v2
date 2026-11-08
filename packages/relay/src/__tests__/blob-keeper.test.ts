import type { SyncEvent } from "@syncmesh/kernel";

import { hashOf, memoryBlobHomes, memoryBlobStore } from "@syncmesh/storage";
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
  scriptedRoom,
  tick,
  write,
} from "./fixtures.js";

const DAY = Temporal.Duration.from({ days: 1 });
const HOUR = Temporal.Duration.from({ hours: 1 });

/** A room on a clock the test moves, one joined socket on it, and the blob store underneath. */
const blobRoom = async (retention: RelayRetention) => {
  let clock = T0;
  const blobs = memoryBlobStore();
  const room = await scriptedRoom({ blobs, retention, now: () => clock });
  const author = peer(40, "acct_a");
  const s = fakeSocket();
  const conn = room.connect(s.socket);
  conn.receive(joinFrame([1], author.identity.peerId, new Map()));
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
    expect(await keeper.sweep()).toBe(0);
    expect(await store.has(hashOf(photo))).toBe(true);
  });

  test("a room that has seen a sealed event sweeps nothing: a reference it cannot read is still one", async () => {
    let clock = T0;
    const store = memoryBlobStore();
    const keeper = createBlobKeeper({
      homes: memoryBlobHomes(),
      store,
      quota: undefined,
      keepUnreferencedFor: DAY,
      now: () => clock,
    });
    const photo = filled(9, 8);
    (await keeper.put(hashOf(photo), photo, ACME)).unwrap();
    const plain = entryOf(await write(peer(41, "acct_b"), "s1", "anything")).event;
    keeper.note({ ...plain, changes: [], sealed: true } satisfies SyncEvent);
    clock = addToInstant(clock, DAY);
    expect(await keeper.sweep()).toBe(0);
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
    expect(await keeper.sweep()).toBe(0);
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
