import { syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";
import { notes, notesSchema, writer as device } from "./crash-fixture.js";

/**
 * What a crash may not cost (E-B durability): a process killed mid-write reopens to exactly
 * the rows it had committed, numbered without a hole; a torn tail on the write-ahead log is
 * recovered to a prefix rather than refused; a damaged file is refused typed, never thrown;
 * and a changed schema refolds the same log into the new shape and back.
 *
 * Real files, a real SIGKILL: the writer is a child process, and what the parent read from its
 * stdout before the kill is the floor of what the store must still hold.
 */

const notesWithTitle = sqliteTable("notes", {
  id: text().primaryKey(),
  body: text().notNull(),
  title: text(),
});
const notesWithTitleSchema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text(), title: t.text().nullable() },
      },
    },
  });

const open = (dataDir: string, schema = notesSchema()) =>
  createMesh({ schema, identity: device, authority: device.peerId, dataDir });

/** Runs the writer until it has printed `atLeast` committed rows, then kills it outright. */
const writeThenKill = async (dataDir: string, atLeast: number): Promise<number> => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "crash-writer.ts"), dataDir], {
    stdout: "pipe",
    stderr: "inherit",
  });
  let committed = 0;
  let text = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  while (committed < atLeast) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    committed = text.split("\n").filter((line) => line.trim() !== "").length;
  }
  child.kill("SIGKILL");
  await child.exited;
  return committed;
};

const rows = async (dataDir: string, schema = notesSchema()) => {
  const mesh = (await open(dataDir, schema)).unwrap();
  const held = await mesh.on().unwrap().db.select().from(notes).orderBy(notes.id);
  const seq = Number((await mesh.engine.cursors()).unwrap().get(device.peerId) ?? 0);
  await mesh.stop();
  return { count: held.length, seq };
};

const logPath = (dataDir: string) => join(dataDir, `${String(device.peerId)}.db`);

describe("what a crash may not cost", () => {
  test("kill -9 mid-write: every committed row is back, numbered without a hole, and the next write follows on", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-crash-"));
    try {
      const committed = await writeThenKill(dataDir, 25);
      expect(committed).toBeGreaterThanOrEqual(25);

      const mesh = (await open(dataDir)).unwrap();
      const handle = mesh.on().unwrap();
      const held = await handle.db.select().from(notes);
      // what the child said it committed is the floor; a write that had not returned may or may not be there
      expect(held.length).toBeGreaterThanOrEqual(committed);
      // the fold agrees with the log: the sequence is the row count, so nothing folded twice or not at all
      const seq = Number((await mesh.engine.cursors()).unwrap().get(device.peerId));
      expect(seq).toBe(held.length);
      await handle.db.insert(notes).values({ id: "after", body: "after the crash" });
      expect(Number((await mesh.engine.cursors()).unwrap().get(device.peerId))).toBe(seq + 1);
      await mesh.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a torn write-ahead log on the state half is healed from the log; the fold never runs ahead of it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-torn-"));
    try {
      const committed = await writeThenKill(dataDir, 25);
      // the killed writer leaves the state file's frames in its WAL, un-checkpointed; tear the
      // tail off. (The log is attached after the WAL pragma and runs in rollback-journal mode,
      // so it has no WAL of its own to tear — every committed entry is already in the file.)
      const wal = readdirSync(dataDir).find((name) => name.endsWith("-wal"));
      expect(wal).toBeDefined();
      const path = join(dataDir, wal ?? "");
      const size = statSync(path).size;
      expect(size).toBeGreaterThan(0);
      truncateSync(path, Math.floor(size / 2));

      // the state reopens at whatever prefix survived, and boot folds the log above it: nothing
      // committed is lost, and the sequence is the row count
      const after = await rows(dataDir);
      expect(after.count).toBeGreaterThanOrEqual(committed);
      expect(after.seq).toBe(after.count);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a damaged file is refused as a value, never a throw", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-damaged-"));
    try {
      const first = (await open(dataDir)).unwrap();
      await first.on().unwrap().db.insert(notes).values({ id: "n1", body: "one" });
      await first.stop();
      // the log's first page: the header SQLite reads before anything else
      const fd = openSync(logPath(dataDir), "r+");
      writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, 0);
      const refused = await open(dataDir);
      expect(refused.isErr()).toBe(true);
      const error = refused.match({ ok: () => undefined, err: (e) => e });
      expect(error?.message).toMatch(/malformed|not a database|damaged|failed/i);
      expect(readdirSync(dataDir).length).toBeGreaterThan(0); // nothing was deleted on the way out
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a changed schema refolds the same log into the new shape, and back", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-migrate-"));
    try {
      const first = (await open(dataDir)).unwrap();
      await first.on().unwrap().db.insert(notes).values({ id: "n1", body: "one" });
      await first.on().unwrap().db.insert(notes).values({ id: "n2", body: "two" });
      await first.stop();

      // the next shape: a nullable column added. Its rows live in a new file beside the log
      const next = (await open(dataDir, notesWithTitleSchema())).unwrap();
      const wide = next.on().unwrap();
      expect(
        (await wide.db.select().from(notesWithTitle).orderBy(notesWithTitle.id)).map((r) => [
          r.body,
          r.title,
        ]),
      ).toEqual([
        ["one", null],
        ["two", null],
      ]);
      await wide.db.insert(notesWithTitle).values({ id: "n3", body: "three", title: "titled" });
      await next.stop();
      // the derived half is named after the shape, so both shapes' files sit beside the one log
      const files = readdirSync(dataDir);
      expect(
        files.filter((f) => f.startsWith(`${String(device.peerId)}.db`)).length,
      ).toBeGreaterThan(1);

      // the previous shape again: its own file is reused and caught up from the log above its coverage
      const back = await rows(dataDir);
      expect(back.count).toBe(3);
      expect(back.seq).toBe(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
