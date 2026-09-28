import type { Transport } from "@syncmesh/transport";

import { createHub, type TelemetryEvent } from "@syncmesh/engine";
import { local, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { memoryBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { MeshTelemetry } from "../telemetry.js";

import { createBlobs } from "../blobs.js";
import { createMesh } from "../mesh.js";
import { createMeshTelemetry } from "../telemetry.js";
import { runTransports } from "../transports.js";

// SAFETY: the fakes below never read their context, so nothing in it is ever dereferenced
const context = {} as Parameters<Transport["start"]>[0];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A transport with only the capabilities it was asked for, so absence stays testable. */
const fake = (name: string, extras: Partial<Transport> = {}): Transport => ({
  name,
  start: () => Promise.resolve(),
  whenReady: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  ...extras,
});

describe("observe: what it must not change", () => {
  test("a capability the transport lacks stays absent, and one it has stays present", () => {
    const seam = createMeshTelemetry();
    const [plain, carrier] = seam.observe([
      fake("radio"),
      fake("relay", {
        blobs: { upload: () => Promise.resolve(), download: () => Promise.resolve(undefined) },
      }),
    ]);
    // `withBlobs()` reads exactly this: a wrapper that defined `blobs` unconditionally would
    // make every medium claim it could carry bytes
    expect(plain?.blobs).toBeUndefined();
    expect(carrier?.blobs).toBeDefined();
    expect(
      runTransports([plain!, carrier!], context)
        .withBlobs()
        .map((t) => t.name),
    ).toEqual(["relay"]);
  });

  test("a capability this seam never heard of still reaches the mesh", () => {
    const seam = createMeshTelemetry();
    // `flush` and `visibility` are members the wrapper does not measure; a wrapper that listed
    // the members it knew about would drop each one `Transport` grows
    const flush = () => Promise.resolve();
    const [observed] = seam.observe([fake("relay", { flush, priority: 3 })]);
    expect(observed?.flush).toBeDefined();
    expect(observed?.priority).toBe(3);
    expect(observed?.name).toBe("relay");
    // and one that never had them still does not
    const [bare] = seam.observe([fake("radio")]);
    expect(bare?.flush).toBeUndefined();
    expect(bare?.priority).toBeUndefined();
  });

  test("priority survives, so nearest-first settling is the order it always was", async () => {
    const asked: string[] = [];
    const source = (name: string, priority: number) =>
      fake(name, {
        priority,
        caughtUp: () => {
          asked.push(name);
          return Promise.resolve();
        },
      });
    const seam = createMeshTelemetry();
    // configured furthest-first on purpose: priority decides, not the array
    const observed = seam.observe([source("radio", 2), source("relay", 1)]);
    expect(observed.map((t) => t.priority)).toEqual([2, 1]);
    await runTransports(observed, context).settled();
    expect(asked).toEqual(["relay", "radio"]);
  });

  test("a transport that fails to start still fails to start", async () => {
    const seam = createMeshTelemetry();
    const [broken] = seam.observe([
      fake("broken", { start: () => Promise.reject(new Error("no network")) }),
    ]);
    let outcome = "started";
    try {
      await broken?.start(context);
    } catch (cause) {
      outcome = String(cause);
    }
    expect(outcome).toContain("no network");
  });
});

describe("mesh.* telemetry (D17)", () => {
  test("starting the links is reported once, for all of them, after the last one is up", async () => {
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    let release = (): void => undefined;
    const slow = fake("slow", { start: () => new Promise<void>((r) => (release = r)) });
    const links = runTransports(seam.observe([fake("fast"), slow]), context);

    await tick();
    expect(seen).toHaveLength(0); // one is still starting, so the pass is not over
    release();
    await links.ready();
    expect(seen.map((e) => e.type)).toEqual(["mesh.transports.start"]);
    expect(seen[0]?.sizes).toEqual({ transports: 2 });
    await links.stop();
  });

  test("settling is one event per pass, not one per source", async () => {
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    const source = (name: string) => fake(name, { caughtUp: () => Promise.resolve() });
    // the third cannot say when it is done, so it is not part of the pass being counted
    const links = runTransports(
      seam.observe([source("relay"), source("radio"), fake("mute")]),
      context,
    );

    await links.settled();
    const settled = seen.filter((e) => e.type === "mesh.transports.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.sizes).toEqual({ transports: 2 });

    await links.settled(); // a second pass is a second event, not a stuck counter
    expect(seen.filter((e) => e.type === "mesh.transports.settled")).toHaveLength(2);
    await links.stop();
  });

  test("presence reports the wire it sent and how many mediums took it", async () => {
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    const links = runTransports(
      seam.observe([
        fake("relay", { sendPresence: () => undefined }),
        fake("radio", { sendPresence: () => undefined }),
        fake("deaf"),
      ]),
      context,
    );

    links.sendPresence(Uint8Array.of(1, 2, 3, 4, 5));
    const sends = seen.filter((e) => e.type === "mesh.presence.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.sizes).toEqual({ bytes: 5, transports: 2 });
    await links.stop();
  });

  test("blob bytes are reported both ways; a fetch nobody answers reports zero", async () => {
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    const held = new Map<string, Uint8Array>();
    const links = runTransports(
      seam.observe([
        fake("relay", {
          blobs: {
            upload: (hash, bytes) => {
              held.set(hash, bytes);
              return Promise.resolve();
            },
            download: (hash) => Promise.resolve(held.get(hash)),
          },
        }),
      ]),
      context,
    );
    const blobs = createBlobs({ store: memoryBlobStore(), transports: () => links.withBlobs() });

    const stored = (await blobs.put(Uint8Array.from({ length: 12 }, (_, i) => i))).unwrap();
    // a fetch of bytes this device already holds never reaches a transport, so ask for others
    const missing = await blobs.fetch(
      // SAFETY: a hash this device does not hold; the fetch path is what is under test
      "b3-0000000000000000000000000000000000000000000000000000000000000000" as typeof stored,
      { timeoutMs: 10 },
    );
    expect(missing.isErr()).toBe(true);

    expect(seen.filter((e) => e.type === "mesh.blob.put").map((e) => e.sizes)).toEqual([
      { bytes: 12 },
    ]);
    expect(seen.filter((e) => e.type === "mesh.blob.fetch").map((e) => e.sizes)).toEqual([
      { bytes: 0 },
    ]);
    await links.stop();
  });
});

describe("follow: one listener rather than three", () => {
  test("the engine's own events arrive on the mesh's seam, and only the engine's", () => {
    const engine = createHub<TelemetryEvent>();
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    seam.follow({ onTelemetry: engine.subscribe });

    const duration = Temporal.Duration.from({ milliseconds: 1 });
    engine.emit({ type: "engine.fold", sizes: { events: 2, keys: 3 }, duration });
    // a relay's events do not travel this way: a mesh re-emits what it runs, not what it dials
    engine.emit({ type: "relay.blob.get", sizes: { bytes: 4 }, duration });
    expect(seen.map((e) => e.type)).toEqual(["engine.fold"]);
  });

  test("a real mesh's writes reach one listener, with sizes and durations", async () => {
    const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
    const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
    const mesh = (
      await createMesh({
        driver: bunSqliteDriver(":memory:"),
        schema: syncSchema({
          // a local table: this write never has to travel to be worth measuring
          tables: {
            notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local },
          },
        }),
        identity: device,
        now: () => Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000),
      })
    ).unwrap();
    const seam = createMeshTelemetry();
    const seen: MeshTelemetry[] = [];
    seam.onTelemetry((event) => void seen.push(event));
    seam.follow(mesh.engine);

    const handle = mesh.on().unwrap();
    await handle.db.insert(notes).values({ id: "n1", body: "one" });

    expect(seen.map((e) => e.type)).toEqual(["engine.mutate", "engine.fold"]);
    expect(seen[0]?.sizes).toEqual({ changes: 1 });
    for (const event of seen)
      expect(event.duration.total({ unit: "milliseconds" })).toBeGreaterThanOrEqual(0);
    await mesh.stop();
  });
});

describe("a listener can never affect the mesh", () => {
  test("a throwing listener is contained, the others still run, and the work still lands", async () => {
    const seam = createMeshTelemetry();
    let reached = 0;
    seam.onTelemetry(() => {
      throw new Error("bad listener");
    });
    seam.onTelemetry(() => void reached++);
    const links = runTransports(seam.observe([fake("relay")]), context);

    await links.ready(); // the start pass emits into the throwing listener
    expect(reached).toBe(1);
    expect(links.running()).toBe(true);
    await links.stop();
  });
});
