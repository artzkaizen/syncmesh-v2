import { describe, expect, test } from "bun:test";

import { hashOf, memoryBlobStore, sqlBlobStore, verifyBlob } from "../blob.js";
import { openPair } from "./pair.js";

const photo = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

describe("the blob store", () => {
  test("the hash is the identity: a put is idempotent, and junk cannot squat a name", async () => {
    {
      const store = memoryBlobStore();
      const hash = (await store.put(photo)).unwrap();
      expect(String(hash)).toBe(String(hashOf(photo)));
      expect((await store.put(photo)).unwrap()).toBe(hash); // storing twice is storing once
      expect(await store.has(hash)).toBe(true);
      expect((await store.get(hash)).unwrap()).toEqual(photo);

      const junk = Uint8Array.of(9, 9, 9);
      const squatted = await store.putAt(hash, junk);
      expect(squatted.isErr() && squatted.error._tag).toBe("BlobCorrupt");
      expect((await store.get(hash)).unwrap()).toEqual(photo); // and the real bytes are untouched

      const absent = await store.get(hashOf(junk));
      expect(absent.isErr() && absent.error._tag).toBe("BlobNotFound");
      await store.delete(hash);
      expect(await store.has(hash)).toBe(false);
    }
  });

  test("a zero-byte blob is a blob", async () => {
    const store = memoryBlobStore();
    const empty = (await store.put(new Uint8Array())).unwrap();
    expect((await store.get(empty)).unwrap()).toEqual(new Uint8Array());
    expect(verifyBlob(empty, new Uint8Array()).isOk()).toBe(true);
  });
});

/**
 * What a backup must include, and what an eviction sweep may take.
 *
 * Bytes this device *made* exist nowhere else until somebody fetches them; bytes that *arrived*
 * under a name are held by whoever sent them. Only the first are lost by dropping them, and the
 * difference is not a policy anyone configures — it is which method stored them (RFC-0022).
 */
describe("a blob's origin decides whether losing it costs anything", () => {
  const bytes = (n: number) => Uint8Array.from({ length: 4 }, (_, i) => n + i);

  test("what this device made is irreplaceable; what arrived is a cache", async () => {
    const driver = await openPair();
    const store = (await sqlBlobStore(driver)).unwrap();

    const mine = (await store.put(bytes(1))).unwrap();
    const theirs = hashOf(bytes(9));
    (await store.putAt(theirs, bytes(9))).unwrap();

    expect(await store.origin(mine)).toBe("mine");
    expect(await store.origin(theirs)).toBe("cached");
    expect(await store.irreplaceable()).toEqual([mine]);
  });

  test("our own bytes coming back from a peer stay ours", async () => {
    const driver = await openPair();
    const store = (await sqlBlobStore(driver)).unwrap();
    const mine = (await store.put(bytes(1))).unwrap();

    // the same bytes arriving from somebody who probably got them from us
    (await store.putAt(mine, bytes(1))).unwrap();

    // demoting them here would license dropping the only copy
    expect(await store.origin(mine)).toBe("mine");
    expect(await store.irreplaceable()).toEqual([mine]);
  });

  test("a hash nobody stored has no origin, rather than a wrong one", async () => {
    const driver = await openPair();
    const store = (await sqlBlobStore(driver)).unwrap();
    expect(await store.origin(hashOf(bytes(5)))).toBeUndefined();
  });
});
