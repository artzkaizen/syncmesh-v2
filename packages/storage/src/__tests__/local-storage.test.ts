import { describe, expect, test } from "bun:test";

import type { LocalStorageLike } from "../local-storage.js";

import { A, B, at, entry, event, grownEntry, seq } from "../driver-tests/fixtures.js";
import { encodeLog } from "../local-log.js";
import { localStorageEventStore } from "../local-storage.js";

/** A `localStorage` whose contents the test can read and damage; `refuse` fails writes to one key, the way a full quota does. */
const fakeStorage = (refuse?: string) => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === refuse) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
  };
};

const open = (storage: LocalStorageLike) => localStorageEventStore({ name: "notes", storage });
const FOREVER = at(9e12);

describe("the localStorage event store", () => {
  test("a newer build's core survives a reopen as the bytes its signature covers", async () => {
    const storage = fakeStorage();
    const newer = grownEntry(A, 1, 100);
    {
      const { store } = (await open(storage)).unwrap();
      (await store.append(newer)).unwrap();
    }
    const { store, corrupt } = (await open(storage)).unwrap();
    expect(corrupt).toBeUndefined();
    const [held] = (await store.all()).unwrap();
    expect(held?.core).toEqual(newer.core);
    expect(held?.sig).toEqual(newer.sig);
  });

  test("events survive a reopen, byte for byte, with their scope and cursors", async () => {
    const storage = fakeStorage();
    const [e1, e2, local] = [entry(A, 1, 100), entry(B, 1, 101), entry(A, 1, 102, { local: true })];
    {
      const { store, corrupt } = (await open(storage)).unwrap();
      expect(corrupt).toBeUndefined();
      (await store.appendBatch([e1, e2, local])).unwrap();
      (await store.append(e1)).unwrap(); // appending twice is appending once
    }
    const { store, corrupt } = (await open(storage)).unwrap();
    expect(corrupt).toBeUndefined();
    expect((await store.all()).unwrap().map((x) => x.event.id)).toEqual(
      [e1, e2, local].map((x) => x.event.id),
    );
    expect((await store.all()).unwrap()[0]?.sig).toEqual(e1.sig);
    expect((await store.has(e1.event.id)).unwrap()).toBe(true);
    expect((await store.has(event(B, 9, 1).id)).unwrap()).toBe(false);
    expect(
      (await store.allSince(new Map([[A, seq(1)]]))).unwrap().map((x) => x.event.peerId),
    ).toEqual([B]);
    expect((await store.allSince(new Map(), "local")).unwrap()).toHaveLength(1);
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(1));
    expect((await store.lastSeq(A, "local")).unwrap()).toBe(seq(1));
    expect((await store.lastSeq(B, "local")).unwrap()).toBeUndefined();
    expect((await store.maxHlc()).unwrap()?.[0].epochMilliseconds).toBe(102);
  });

  test("a corrupt log recovers empty AND says so — and the clock does not come back with it", async () => {
    const storage = fakeStorage();
    {
      const { store } = (await open(storage)).unwrap();
      (await store.appendBatch([entry(A, 1, 100), entry(A, 2, 200)])).unwrap();
    }
    storage.items.set("notes.log", "not hex, not cbor, not a log");

    const { store, corrupt } = (await open(storage)).unwrap();
    expect(corrupt?._tag).toBe("LogCorrupt");
    expect((await store.all()).unwrap()).toEqual([]); // empty, so the app boots
    // and the marks a peer already saw are still in front of anything this device will number
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
    expect((await store.maxHlc()).unwrap()?.[0].epochMilliseconds).toBe(200);

    const again = (await open(storage)).unwrap();
    expect(again.corrupt).toBeUndefined(); // the damaged bytes were replaced, not left to be re-found
    expect((await again.store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
  });

  test("a corrupt head takes the entries with it, but never the mark they set", async () => {
    const storage = fakeStorage();
    {
      const { store } = (await open(storage)).unwrap();
      (await store.appendBatch([entry(A, 1, 100), entry(A, 2, 200)])).unwrap();
    }
    storage.items.set("notes.head", "00ff00ff");

    const { store, corrupt, numberingLost } = (await open(storage)).unwrap();
    expect(corrupt?._tag).toBe("LogCorrupt");
    // the contents go: no floor survived, so a log compaction trimmed reads the same as a whole
    // one, and nothing here can tell which this is
    expect((await store.all()).unwrap()).toEqual([]);
    expect(storage.items.get("notes.log")).toBe(encodeLog([]));

    // the mark does not. Numbering from zero re-issues sequence numbers peers already hold under
    // different ids, and `has()` then drops every new event on every peer, silently, forever
    expect((await store.lastSeq(A, "synced")).unwrap()).toEqual(seq(2));
    expect((await store.maxHlc()).unwrap()?.[0]).toEqual(at(200));
    expect(numberingLost).toBeUndefined();
  });

  test("both keys damaged: nothing says where it had got to, and it says so", async () => {
    const storage = fakeStorage();
    {
      const { store } = (await open(storage)).unwrap();
      (await store.appendBatch([entry(A, 1, 100)])).unwrap();
    }
    storage.items.set("notes.head", "00ff00ff");
    storage.items.set("notes.log", "not a log");

    const { store, corrupt, numberingLost } = (await open(storage)).unwrap();
    expect(corrupt?._tag).toBe("LogCorrupt");
    // no mark survived anywhere, and only a peer holding this device's past can supply one. The
    // store opens — it can still read and still receive — and refuses to pretend it knows
    expect(numberingLost).toBe(true);
    expect((await store.lastSeq(A, "synced")).unwrap()).toBeUndefined();
  });

  test("compaction survives the reopen: the floor stays, and lastSeq does not fall to what is left", async () => {
    const storage = fakeStorage();
    {
      const { store } = (await open(storage)).unwrap();
      (await store.appendBatch([entry(A, 1, 100), entry(A, 2, 200), entry(A, 3, 300)])).unwrap();
      const removed = (
        await store.compactBelow(new Map([[A, seq(2)]]), "synced", FOREVER)
      ).unwrap();
      expect(removed).toBe(2);
    }
    const { store } = (await open(storage)).unwrap();
    expect((await store.all()).unwrap()).toHaveLength(1);
    expect((await store.compactedBelow()).unwrap().synced.get(A)).toBe(seq(2));
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(3));
    expect((await store.maxHlc()).unwrap()?.[0].epochMilliseconds).toBe(300);
  });

  test("a refused write is an error, and still moves the mark it claimed", async () => {
    const storage = fakeStorage("notes.log");
    const { store } = (await open(storage)).unwrap();
    const full = await store.appendBatch([entry(A, 1, 100), entry(A, 2, 200)]);
    expect(full.isErr() && full.error._tag).toBe("StoreFailure");
    // the events are gone, but their sequence numbers are spent: the next write cannot re-issue one
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
    const reopened = (await open(storage)).unwrap();
    expect((await reopened.store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
  });

  test("no localStorage is a different answer from a broken one", async () => {
    const absent = await localStorageEventStore({ name: "notes" });
    expect(absent.isErr() && absent.error._tag).toBe("StoreFailure");
  });
});
