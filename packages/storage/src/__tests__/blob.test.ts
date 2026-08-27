import { describe, expect, test } from "bun:test";

import { hashOf, memoryBlobStore, verifyBlob } from "../blob.js";

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
