import type { SqlValue } from "@syncmesh/storage";

import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { bytesToHex, createKeyVault, createPlaintextVault } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { relayIdentity, relaySecret } from "../relay-meta.js";

/**
 * The relay's own secrets at rest (N26): a room's signing seed beside its log is sealed by the
 * vault the host is given, as a device's seed is (D49), so a copy of the database is not the key.
 */

const KEY = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const quiet = { onNotice: () => undefined };
/** Every byte of every file in `dir`: the database and its WAL. */
const everyByte = (dir: string) =>
  readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString("latin1"));
const stored = async (driver: ReturnType<typeof bunSqliteDriver>, key: string) =>
  String((await driver.all(`SELECT "value" FROM "_relay_meta" WHERE "key" = ?`, [key]))[0]?.[0]);

describe("a relay's secrets at rest (N26)", () => {
  test("the room's seed is stored sealed, and the same vault opens the same key again", async () => {
    const driver = bunSqliteDriver(":memory:");
    const vault = createKeyVault(KEY);
    const first = await relayIdentity(driver, { vault, ...quiet });
    const row = await stored(driver, "identity-seed");
    expect(row.startsWith("sealed:key:")).toBe(true);
    const again = await relayIdentity(driver, { vault, ...quiet });
    expect(again.peerId).toBe(first.peerId);
    // the sealed row does not carry the seed: the seed is what signs, and the row is not it
    const seed = await relaySecret(driver, "identity-seed", { vault, ...quiet });
    expect(row.includes(bytesToHex(seed))).toBe(false);
  });

  test("a seed an earlier build left in plaintext is sealed in place, and keeps its name", async () => {
    const driver = bunSqliteDriver(":memory:");
    const before = await relayIdentity(driver, { vault: createPlaintextVault(), ...quiet });
    const plain = await stored(driver, "identity-seed");
    expect(plain.startsWith("sealed:")).toBe(false);
    const said: string[] = [];
    const after = await relayIdentity(driver, {
      vault: createKeyVault(KEY),
      onNotice: (message) => void said.push(message),
    });
    expect(after.peerId).toBe(before.peerId);
    expect((await stored(driver, "identity-seed")).startsWith("sealed:key:")).toBe(true);
    expect(said.some((message) => message.includes("out of plaintext"))).toBe(true);
  });

  test("sealing a plaintext seed in place scrubs its old bytes from the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-relay-meta-"));
    const path = join(dir, "room.db");
    const first = bunSqliteDriver(path);
    await relayIdentity(first, { vault: createPlaintextVault(), ...quiet });
    const plain = await stored(first, "identity-seed");
    await first.close?.();
    expect(everyByte(dir).some((bytes) => bytes.includes(plain))).toBe(true);

    const driver = bunSqliteDriver(path);
    // off, as SQLite builds without SECURE_DELETE ship it: the move turns it on for its statement
    await driver.run("PRAGMA secure_delete = 0");
    const said: string[] = [];
    await relayIdentity(driver, {
      vault: createKeyVault(KEY),
      onNotice: (message) => void said.push(message),
    });
    expect((await driver.all("PRAGMA secure_delete"))[0]?.[0]).toBe(0);
    expect(said).toEqual([
      "moved the relay's identity-seed out of plaintext, sealed by the key vault",
    ]);
    // read while the connection is still open: a close would checkpoint and tidy what the move left
    for (const bytes of everyByte(dir)) expect(bytes.includes(plain)).toBe(false);
    await driver.close?.();
  });

  test("a database that refuses the scrub says the plaintext may remain", async () => {
    const inner = bunSqliteDriver(":memory:");
    await relayIdentity(inner, { vault: createPlaintextVault(), ...quiet });
    const driver = {
      ...inner,
      all: (sql: string, params?: readonly SqlValue[]) =>
        sql.startsWith("PRAGMA secure_delete")
          ? Promise.reject(new Error("not authorized"))
          : inner.all(sql, params),
    };
    const said: string[] = [];
    await relayIdentity(driver, {
      vault: createKeyVault(KEY),
      onNotice: (message) => void said.push(message),
    });
    expect(said.some((message) => message.includes("free pages"))).toBe(true);
    expect((await stored(inner, "identity-seed")).startsWith("sealed:key:")).toBe(true);
  });

  test("a seed the vault cannot open is refused, never replaced by a new one", async () => {
    const driver = bunSqliteDriver(":memory:");
    await relayIdentity(driver, { vault: createKeyVault(KEY), ...quiet });
    const row = await stored(driver, "identity-seed");
    await expect(relayIdentity(driver, { vault: createKeyVault(OTHER), ...quiet })).rejects.toThrow(
      "cannot open",
    );
    await expect(
      relayIdentity(driver, { vault: createPlaintextVault(), ...quiet }),
    ).rejects.toThrow("sealed by the key vault");
    expect(await stored(driver, "identity-seed")).toBe(row);
  });

  test("the plaintext vault says so at every open", async () => {
    const driver = bunSqliteDriver(":memory:");
    const said: string[] = [];
    await relayIdentity(driver, {
      vault: createPlaintextVault(),
      onNotice: (message) => void said.push(message),
    });
    expect(said.some((message) => message.startsWith("RELAY SECRET IN PLAINTEXT"))).toBe(true);
  });
});
