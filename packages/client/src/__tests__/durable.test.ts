import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    tables: {
      notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
    },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

describe("durable by default", () => {
  test("no store given: one SQLite file per identity under dataDir; a restart resumes, never regresses", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-"));
    try {
      const first = (
        await createMesh({ schema: schema(), identity: device, dataDir, now: () => T0 })
      ).unwrap();
      (await first.notes.create({ id: "n1", body: "one" })).unwrap();
      (await first.notes.create({ id: "n2", body: "two" })).unwrap();
      await first.stop();
      expect(existsSync(join(dataDir, `${String(device.peerId)}.db`))).toBe(true);

      // a fresh process over the same file: rows are back without a peer, and the next write
      // is numbered above the stored ones (D05 — the clock passes every stored stamp on boot)
      const second = (
        await createMesh({ schema: schema(), identity: device, dataDir, now: () => T0 })
      ).unwrap();
      expect(second.notes.list().map((r) => r.body)).toEqual(["one", "two"]);
      const receipt = (
        await second.tx((c) => c.notes.create({ id: "n3", body: "three" }).map(() => undefined))
      ).unwrap();
      expect(String(receipt.eventId).endsWith("-L3")).toBe(true);
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a store you pass in is yours: stop leaves it open", async () => {
    const { createMemoryEventStore } = await import("@syncmesh/engine");
    const store = createMemoryEventStore();
    const mesh = (
      await createMesh({ schema: schema(), identity: device, store, now: () => T0 })
    ).unwrap();
    (await mesh.notes.create({ id: "n1", body: "one" })).unwrap();
    await mesh.stop();
    expect((await store.all()).unwrap()).toHaveLength(1);
  });
});
