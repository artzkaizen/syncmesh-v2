import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { bytesToHex, createKeyVault, createPlaintextVault } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { relayIdentity, relaySecret } from "../relay-meta.js";

/**
 * The relay's own secrets at rest (N26): a room's signing seed beside its log is sealed by the
 * vault the host is given, as a device's seed is (D49), so a copy of the database is not the key.
 */

const KEY = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const quiet = { onNotice: () => undefined };
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

  test("a seed the vault cannot open is refused, never replaced by a new one", async () => {
    const driver = bunSqliteDriver(":memory:");
    await relayIdentity(driver, { vault: createKeyVault(KEY), ...quiet });
    const row = await stored(driver, "identity-seed");
    expect(relayIdentity(driver, { vault: createKeyVault(OTHER), ...quiet })).rejects.toThrow(
      "cannot open",
    );
    expect(relayIdentity(driver, { vault: createPlaintextVault(), ...quiet })).rejects.toThrow(
      "sealed by the key vault",
    );
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
