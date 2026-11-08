import type { PeerId } from "@syncmesh/kernel";

import { createClient, sqlite } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBackend } from "../embedded/backend.js";
import { identityNamed } from "../identity.js";
import { INSTANCE, INVITE, notes, notesSchema } from "../notes.js";

const until = async (check: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return check();
};

/** A phone as `device.ts` builds one: its own SQLite file, its own key, the issuer's id as config. */
const phone = async (name: string, dialing: string, issuer: PeerId, dir: string) => {
  const client = createClient({
    schema: notesSchema(),
    identity: identityNamed(`device:${name}`),
    storage: sqlite({ driver: bunSqliteDriver(join(dir, `device-${name}.db`)) }),
    trust: { issuer },
    transports: [relayTransport({ dial: webSocketDial(dialing), reconnectMs: 20 })],
  });
  await client.$ready; // `$mesh` throws until the mesh has opened
  return client.$mesh;
};

/** Asks for a grant with the invite and waits until the phone may write. */
const admitted = async (mesh: Awaited<ReturnType<typeof phone>>): Promise<boolean> => {
  await mesh.ready();
  mesh.requestGrant(INVITE);
  return until(() => mesh.can("notes.insert", undefined, INSTANCE));
};

describe("the relay inside the backend you already run (D09-A, E25)", () => {
  test("a phone's write lands in the backend's own table, read with plain Drizzle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-embedded-"));
    const backend = await openBackend({ dataDir: dir });
    try {
      const alice = await phone("alice", backend.dialing, backend.issuer, dir);
      expect(await admitted(alice)).toBe(true);
      await alice
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "a1", body: "first note", author: "alice" });
      await alice.flush();

      // no mesh API in the query path: the fold UPSERTed the row into `notes` itself
      const landed = await until(async () => (await backend.db.select().from(notes)).length === 1);
      expect(landed).toBe(true);
      expect(await backend.db.select().from(notes)).toEqual([
        { id: "a1", body: "first note", author: "alice" },
      ]);
      await alice.stop();
    } finally {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a second phone catches up through the in-process relay, and a wrong invite is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-embedded-"));
    const said: string[] = [];
    const backend = await openBackend({ dataDir: dir, onGrant: (line) => said.push(line) });
    try {
      const alice = await phone("alice", backend.dialing, backend.issuer, dir);
      expect(await admitted(alice)).toBe(true);
      await alice
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "a1", body: "first", author: "alice" });
      await alice.flush();

      const bob = await phone("bob", backend.dialing, backend.issuer, dir);
      expect(await admitted(bob)).toBe(true);
      const caughtUp = await until(
        async () => (await bob.on(INSTANCE).unwrap().db.select().from(notes)).length === 1,
      );
      expect(caughtUp).toBe(true);

      const mallory = await phone("mallory", backend.dialing, backend.issuer, dir);
      await mallory.ready();
      mallory.requestGrant("not-the-invite");
      expect(await until(() => said.some((line) => line.includes("wrong invite")))).toBe(true);
      expect(mallory.can("notes.insert", undefined, INSTANCE)).toBe(false);

      for (const mesh of [alice, bob, mallory]) await mesh.stop();
    } finally {
      await backend.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a restarted backend answers from its table at once, without replaying the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-embedded-"));
    const first = await openBackend({ dataDir: dir });
    const alice = await phone("alice", first.dialing, first.issuer, dir);
    try {
      expect(await admitted(alice)).toBe(true);
      await alice
        .on(INSTANCE)
        .unwrap()
        .db.insert(notes)
        .values({ id: "a1", body: "kept", author: "alice" });
      await alice.flush();
      expect(await until(async () => (await first.db.select().from(notes)).length === 1)).toBe(
        true,
      );
    } finally {
      await alice.stop();
      await first.stop();
    }
    const again = await openBackend({ dataDir: dir });
    try {
      expect(await again.db.select().from(notes)).toEqual([
        { id: "a1", body: "kept", author: "alice" },
      ]);
    } finally {
      await again.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
