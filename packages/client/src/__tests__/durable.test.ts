import { createMemoryEventStore } from "@syncmesh/engine";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } }, // global
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const open = (dataDir: string) =>
  createMesh({
    schema: schema(),
    identity: device,
    authority: device.peerId, // this device may write the global table
    dataDir,
    now: () => T0,
  });

describe("durable by default", () => {
  test("no store given: one SQLite file per identity under dataDir; a restart resumes, never regresses", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-"));
    try {
      const first = (await open(dataDir)).unwrap();
      const h1 = first.on().unwrap();
      await h1.db.insert(notes).values({ id: "n1", body: "one" });
      await h1.db.insert(notes).values({ id: "n2", body: "two" });
      await first.stop();
      expect(existsSync(join(dataDir, `${String(device.peerId)}.db`))).toBe(true);

      // a fresh process over the same file: rows are back without a peer, and the next write
      // is numbered above the stored ones (D05 — the clock passes every stored stamp on boot)
      const second = (await open(dataDir)).unwrap();
      const h2 = second.on().unwrap();
      expect(
        (await h2.db.select({ body: notes.body }).from(notes).orderBy(notes.id)).map((r) => r.body),
      ).toEqual(["one", "two"]);
      await h2.db.insert(notes).values({ id: "n3", body: "three" });
      expect(Number((await second.engine.cursors()).unwrap().get(device.peerId))).toBe(3);
      await second.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a bare event store is yours and carries no SQL: stop leaves it open, on() names the fix", async () => {
    const store = createMemoryEventStore();
    const mesh = (
      await createMesh({ schema: schema(), identity: device, store, now: () => T0 })
    ).unwrap();
    expect(() => mesh.on()).toThrow("no SQL connection");
    await mesh.stop();
    expect((await store.all()).unwrap()).toHaveLength(0); // still open, still readable
  });
});
