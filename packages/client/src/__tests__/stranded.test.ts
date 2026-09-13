import type { EngineError, StrandedWrites } from "@syncmesh/engine";

import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

/**
 * **A mesh can now be told what its engine found while it was opening.**
 *
 * `mesh.engine.onError` has always been there for the life of the process, and for almost
 * everything that is the right door. The exception is boot: `openEngine` audits the log for
 * writes no key on this device can ever sign — the wreckage a key rotation over a kept log leaves
 * — and it does that *inside* the call a caller would have subscribed through. Without
 * `MeshOptions.onError` the audit ran and spoke to nobody, so a device holding a run it could
 * never deliver started up looking exactly like a healthy one.
 *
 * What is pinned here is that the report reaches an app that asked for it, and that the mesh
 * opens anyway: the rows those events folded into are on the screen, and refusing to open would
 * brick precisely the databases this has already happened to.
 */

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } }, // global
  });

const key = (seed: number) =>
  createIdentity(Uint8Array.from({ length: 32 }, (_, i) => seed + i)).unwrap();

const deviceA = key(90);
const deviceB = key(140);
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/**
 * The driver comes back beside the mesh because a driver passed in stays the caller's to close —
 * and this test reopens the same file, so somebody has to.
 */
const open = async (
  file: string,
  device: typeof deviceA,
  onError?: (error: EngineError) => void,
) => {
  const driver = bunSqliteDriver(file);
  const mesh = (
    await createMesh({
      schema: schema(),
      identity: device,
      // this device may write the global table; what rotates below is the *device* key
      authority: device.peerId,
      driver,
      now: () => T0,
      ...(onError !== undefined && { onError }),
    })
  ).unwrap();
  return {
    mesh,
    close: async () => {
      await mesh.stop();
      await driver.close?.();
    },
  };
};

const strandedOf = (heard: readonly EngineError[]) =>
  heard.filter((e): e is StrandedWrites => e._tag === "StrandedWrites");

describe("a mesh over a log whose author it no longer is", () => {
  test("tells the app at boot, opens anyway, and keeps the rows those writes folded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-stranded-"));
    const file = join(dir, "one.db");
    try {
      const first = await open(file, deviceA);
      const h1 = first.mesh.on().unwrap();
      await h1.db.insert(notes).values({ id: "n1", body: "one" });
      await h1.db.insert(notes).values({ id: "n2", body: "two" });
      await first.close();

      const heard: EngineError[] = [];
      const second = await open(file, deviceB, (error) => void heard.push(error));

      const stranded = strandedOf(heard);
      expect(stranded).toHaveLength(1);
      expect(stranded[0]?.author).toBe(deviceA.peerId);
      expect(stranded[0]?.count).toBe(2);
      // the state is intact: the writes folded on the way in and nothing here unfolds them
      const h2 = second.mesh.on().unwrap();
      expect(
        (await h2.db.select({ body: notes.body }).from(notes).orderBy(notes.id)).map((r) => r.body),
      ).toEqual(["one", "two"]);
      // and the same answer is available on demand, for a screen rather than a boot listener
      expect((await second.mesh.recovery.stranded()).unwrap()).toHaveLength(1);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mesh whose key never moved hears nothing and has nothing stranded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-stranded-"));
    const file = join(dir, "one.db");
    try {
      const heard: EngineError[] = [];
      const only = await open(file, deviceA, (error) => void heard.push(error));
      const handle = only.mesh.on().unwrap();
      await handle.db.insert(notes).values({ id: "n1", body: "one" });
      expect(strandedOf(heard)).toEqual([]);
      expect((await only.mesh.recovery.stranded()).unwrap()).toEqual([]);
      await only.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
