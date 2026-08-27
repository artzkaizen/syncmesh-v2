import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";

import type { OpenDriver } from "./index.js";

import { hashOf, sqlBlobStore } from "../blob.js";

const photo = Uint8Array.from({ length: 2048 }, (_, i) => i % 251);

/** Bytes in the database the rest of the mesh uses (D18) — what a relay's durable home needs. */
export const blobCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "blobs: the hash is the identity — a put is idempotent, and junk cannot squat a name",
    run: async () => {
      const store = (await sqlBlobStore(await openDriver("blobs"))).unwrap();
      const hash = (await store.put(photo)).unwrap();
      equal(String(hash), String(hashOf(photo)), "the name is the content");
      equal(
        String((await store.put(photo)).unwrap()),
        String(hash),
        "storing twice is storing once",
      );
      equal(await store.has(hash), true, "held");
      equal((await store.get(hash)).unwrap(), photo, "bytes back");

      const junk = Uint8Array.of(9, 9, 9);
      const squatted = await store.putAt(hash, junk);
      equal(squatted.isErr() ? squatted.error._tag : "ok", "BlobCorrupt", "junk refused");
      equal((await store.get(hash)).unwrap(), photo, "and the real bytes are untouched");

      const absent = await store.get(hashOf(junk));
      equal(absent.isErr() ? absent.error._tag : "ok", "BlobNotFound", "unknown name");
      await store.delete(hash);
      equal(await store.has(hash), false, "forgotten");
    },
  },
  {
    name: "blobs: a zero-byte blob is a blob, and survives a reopen",
    run: async () => {
      const store = (await sqlBlobStore(await openDriver("blobs-empty"))).unwrap();
      const empty = (await store.put(new Uint8Array())).unwrap();
      const reopened = (await sqlBlobStore(await openDriver("blobs-empty"))).unwrap();
      equal((await reopened.get(empty)).unwrap(), new Uint8Array(), "zero bytes, still there");
    },
  },
];
