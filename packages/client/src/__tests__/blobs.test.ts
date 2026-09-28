import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { hashOf } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), photo: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const photo = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);

const device = async (url: string, n: number) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [relayTransport({ dial: webSocketDial(url), reconnectMs: 20 })],
    })
  ).unwrap();

describe("a blob through the relay", () => {
  test("one device puts, another fetches verified, and a restart still has it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-blobs-"));
    try {
      let relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
      const a = await device(relay.url, 40);
      const b = await device(relay.url, 80);
      await Promise.all([a.ready(), b.ready()]);

      const hash = (await a.blobs.put(photo)).unwrap();
      expect(await a.blobs.has(hash)).toBe(true);
      expect(await b.blobs.has(hash)).toBe(false); // b has the name, not the bytes

      const fetched = await b.blobs.fetch(hash, { timeoutMs: 3000 });
      expect(fetched.unwrap()).toEqual(photo);
      expect(await b.blobs.has(hash)).toBe(true); // and now it is cached here

      // a hash nobody holds is a value, and recoverable — not a throw
      const missing = await b.blobs.fetch(hashOf(Uint8Array.of(1, 2, 3)), { timeoutMs: 500 });
      expect(missing.isErr() && missing.error._tag).toBe("BlobTimeout");

      await a.stop();
      await b.stop();
      await relay.stop();

      // the relay is the durable home: a fresh process over the same directory still serves it
      relay = await startRelay(relay.port, { dataDir, keepaliveMs: 60_000 });
      const c = await device(relay.url, 120);
      await c.ready();
      expect((await c.blobs.fetch(hash, { timeoutMs: 3000 })).unwrap()).toEqual(photo);
      await c.stop();
      await relay.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a mesh with no transport that carries bytes says so, rather than pretending", async () => {
    const alone = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: schema(),
        identity: createIdentity(seed(200)).unwrap(),
        now: () => T0,
      })
    ).unwrap();
    const put = await alone.blobs.put(photo);
    expect(put.isErr() && put.error._tag).toBe("NoSuchCapability");
    // it still cached the bytes locally, so a fetch of what it holds needs no radio at all
    expect(await alone.blobs.has(hashOf(photo))).toBe(true);
    expect((await alone.blobs.fetch(hashOf(photo))).unwrap()).toEqual(photo);
    await alone.stop();
  });
});

describe("the blob surface (book ch. 12)", () => {
  test("stream yields the verified bytes; retain refcounts; progress ticks on arrival", async () => {
    const { createBlobs } = await import("../blobs.js");
    const { hashOf, memoryBlobStore } = await import("@syncmesh/storage");
    const blobs = createBlobs({ store: memoryBlobStore(), transports: () => [] });
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => i % 251);

    const hash = hashOf(bytes);
    expect((await blobs.fetch(hash)).isErr()).toBe(true); // nothing local, nobody to ask

    const ticks: (readonly [number, number | undefined])[] = [];
    // the cache path is what this surface owns end to end: seed the store, then read through it
    const seeded = memoryBlobStore();
    (await seeded.putAt(hash, bytes)).unwrap();
    const local = createBlobs({ store: seeded, transports: () => [] });

    const fetched = await local.fetch(hash, {
      onProgress: (got, total) => void ticks.push([got, total]),
    });
    expect(fetched.unwrap()).toEqual(bytes);
    expect(ticks).toEqual([[512, 512]]); // cached: one honest tick, arrival == total

    const chunks: Uint8Array[] = [];
    const reader = local.stream(hash).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(bytes);

    local.retain(hash);
    local.retain(hash);
    local.release(hash);
    expect(local.retained(hash)).toBe(1); // still held once: a sweep must leave it
    local.release(hash);
    expect(local.retained(hash)).toBe(0);
  });
});
