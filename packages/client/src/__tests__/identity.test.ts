import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { bytesToHex, hexToBytes, openPayload } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SecretStore, SeedVault } from "../vault.js";

import { deviceIdentity } from "../identity.js";
import {
  createPlaintextVault,
  createSecretStoreVault,
  createWebCryptoVault,
  platformVault,
} from "../vault.js";

/**
 * The device key is the one thing a relay makes dangerous to get wrong. Two installs
 * under one `peerId` are one author with two sequence streams, and the failure is not an error —
 * it is a write folded, found to be below a cursor the other install already moved, and dropped.
 * So the two properties are tested directly: it survives a reboot, and it is never shared.
 *
 * And since U4 a third: the file is not the key. A copy of the database holds the seed only as a
 * keystore sealed it, so it opens nothing on a device without that keystore.
 */

const driverOn = (path: string) => bunSqliteDriver(path);
const plaintext = createPlaintextVault();
const quiet = { vault: plaintext, onNotice: () => {} };

/** A secret store in memory, standing in for a platform keychain: one per "device". */
const memoryStore = (): SecretStore & { readonly held: Map<string, string> } => {
  const held = new Map<string, string>();
  return {
    held,
    get: (name) => Promise.resolve(held.get(name)),
    set: (name, value) => Promise.resolve(void held.set(name, value)),
  };
};

const freshDir = () => mkdtempSync(join(tmpdir(), "syncmesh-identity-"));

/** Every byte of every file in `dir`: the database, its WAL and the attached log. */
const everyByte = (dir: string) =>
  readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString("latin1"));

const storedRow = async (path: string) => {
  const driver = driverOn(path);
  const value = String(
    (await driver.all(`SELECT "value" FROM "_device" WHERE "key" = 'seed'`))[0]?.[0],
  );
  await driver.close?.();
  return value;
};

/** The seed a secret-store vault sealed, opened with the store's key the way an attacker holding both would. */
const sealedSeed = (row: string, store: ReturnType<typeof memoryStore>) => {
  const sealed = hexToBytes(row.slice("sealed:secret-store:".length)).unwrap();
  // the first 16 bytes name the seal's own key in the store
  const name = `syncmesh.device-seed-key.${bytesToHex(sealed.slice(0, 16))}`;
  const key = hexToBytes(store.held.get(name) ?? "").unwrap();
  return openPayload(
    key,
    sealed.slice(16),
    new TextEncoder().encode("syncmesh/device-seed/v1"),
  ).unwrap();
};

/** Long enough for the faster of two concurrent boots to seal and write its row. */
const slowerKeychain = () => new Promise((resolve) => setTimeout(resolve, 30));

/** `store`, with every write after the first landing late, as a slower keychain's would. */
const slowSecondWrite = (store: SecretStore): SecretStore => {
  let writes = 0;
  return {
    get: (name) => store.get(name),
    set: async (name, value) => {
      if (writes++ > 0) await slowerKeychain();
      return store.set(name, value);
    },
  };
};

describe("deviceIdentity", () => {
  test("the same database is the same device, however many times it is opened", async () => {
    const path = `/tmp/issues-identity-${String(Date.now())}-${String(Math.random())}.db`;
    const first = (await deviceIdentity(driverOn(path), quiet)).unwrap();
    // a fresh driver over the same file, which is what a reload is
    const again = (await deviceIdentity(driverOn(path), quiet)).unwrap();
    expect(again.peerId).toBe(first.peerId);
    // and it can still sign, so what came back is a key and not just an id
    expect(again.sign(Uint8Array.of(1, 2, 3))).toEqual(first.sign(Uint8Array.of(1, 2, 3)));
  });

  test("a second database is a second device, which is what a second browser profile is", async () => {
    const stamp = `${String(Date.now())}-${String(Math.random())}`;
    const one = (await deviceIdentity(driverOn(`/tmp/issues-a-${stamp}.db`), quiet)).unwrap();
    const two = (await deviceIdentity(driverOn(`/tmp/issues-b-${stamp}.db`), quiet)).unwrap();
    expect(two.peerId).not.toBe(one.peerId);
  });

  test("a key the database cannot hold is a refusal, never a fresh key", async () => {
    // a device that minted a new key whenever it could not read the old one would author under a
    // new name on every reload, which is the crowd-of-strangers log the persistence exists to stop
    const driver = driverOn(":memory:");
    await driver.run(`CREATE TABLE "_device" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`);
    await driver.run(`INSERT INTO "_device" ("key", "value") VALUES ('seed', 'not-hex')`);
    const opened = await deviceIdentity(driver, quiet);
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) expect(opened.error._tag).toBe("DeviceKeyUnavailable");
  });
});

describe("the seed at rest (U4)", () => {
  test("with no vault and no keystore on the platform the open is refused, and nothing is written", async () => {
    // Bun has no IndexedDB: plaintext is never the silent default
    expect(platformVault()).toBeUndefined();
    const driver = driverOn(":memory:");
    const opened = await deviceIdentity(driver);
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) {
      expect(opened.error._tag).toBe("DeviceKeyUnavailable");
      expect(opened.error.message).toContain("createPlaintextVault");
    }
    const tables = await driver.all(`SELECT name FROM sqlite_master WHERE name = '_device'`);
    expect(tables).toEqual([]);
  });

  test("a plaintext vault says so at every boot", async () => {
    const path = join(freshDir(), "loud.db");
    const said: string[] = [];
    const onNotice = (message: string) => said.push(message);
    (await deviceIdentity(driverOn(path), { vault: plaintext, onNotice })).unwrap();
    (await deviceIdentity(driverOn(path), { vault: plaintext, onNotice })).unwrap();
    expect(said.filter((m) => m.startsWith("DEVICE KEY IN PLAINTEXT"))).toHaveLength(2);
  });

  test("a sealed seed is nowhere in the database's files", async () => {
    const dir = freshDir();
    const path = join(dir, "sealed.db");
    const store = memoryStore();
    const said: string[] = [];
    const vault = createSecretStoreVault(store);
    const first = (
      await deviceIdentity(driverOn(path), { vault, onNotice: (m) => said.push(m) })
    ).unwrap();
    expect(said).toEqual([]);
    const row = await storedRow(path);
    expect(row.startsWith("sealed:secret-store:")).toBe(true);
    const seed = sealedSeed(row, store);
    // neither the hex a plaintext row would hold nor the raw bytes, in any file of the store
    for (const bytes of everyByte(dir)) {
      expect(bytes.includes(bytesToHex(seed))).toBe(false);
      expect(bytes.includes(Buffer.from(seed).toString("latin1"))).toBe(false);
    }
    const again = (await deviceIdentity(driverOn(path), { vault })).unwrap();
    expect(again.peerId).toBe(first.peerId);
  });

  test("a copy of the database on another device opens no key, and mints none", async () => {
    const dir = freshDir();
    const path = join(dir, "stolen.db");
    const home = memoryStore();
    const mine = (
      await deviceIdentity(driverOn(path), { vault: createSecretStoreVault(home) })
    ).unwrap();
    // the attacker copies every file of the store, and has their own keychain, not this one's
    const elsewhere = freshDir();
    for (const name of readdirSync(dir)) copyFileSync(join(dir, name), join(elsewhere, name));
    const copied = join(elsewhere, "stolen.db");
    const before = await storedRow(copied);
    const theirs = await deviceIdentity(driverOn(copied), {
      vault: createSecretStoreVault(memoryStore()),
    });
    expect(theirs.isErr()).toBe(true);
    if (theirs.isErr()) expect(theirs.error.message).toContain("copied from another device");
    // refused, not replaced: the row is what it was, so the real keystore still opens it
    expect(await storedRow(copied)).toBe(before);
    const back = (
      await deviceIdentity(driverOn(copied), { vault: createSecretStoreVault(home) })
    ).unwrap();
    expect(back.peerId).toBe(mine.peerId);
  });

  test("a plaintext seed from an earlier build is sealed in place, and its bytes leave the files", async () => {
    const dir = freshDir();
    const path = join(dir, "upgrade.db");
    const before = (await deviceIdentity(driverOn(path), quiet)).unwrap();
    const plainRow = await storedRow(path);
    expect(plainRow).toMatch(/^[0-9a-f]{64}$/);
    expect(everyByte(dir).some((bytes) => bytes.includes(plainRow))).toBe(true);

    const store = memoryStore();
    const said: string[] = [];
    const vault = createSecretStoreVault(store);
    // the connection's own setting is off, as SQLite builds without SECURE_DELETE ship it; the
    // migration turns it on for its one statement and puts it back
    const driver = driverOn(path);
    await driver.run("PRAGMA secure_delete = 0");
    const after = (await deviceIdentity(driver, { vault, onNotice: (m) => said.push(m) })).unwrap();
    expect((await driver.all("PRAGMA secure_delete"))[0]?.[0]).toBe(0);
    await driver.close?.();
    // the same device: migrating is not a new identity
    expect(after.peerId).toBe(before.peerId);
    expect(said).toEqual([
      "moved this install's device key out of plaintext, sealed by the secret-store vault",
    ]);
    const row = await storedRow(path);
    expect(row.startsWith("sealed:secret-store:")).toBe(true);
    expect(bytesToHex(sealedSeed(row, store))).toBe(plainRow);
    // secure_delete zeroed the old cell and the WAL checkpoint dropped the frames that held it
    for (const bytes of everyByte(dir)) expect(bytes.includes(plainRow)).toBe(false);
  });

  test("a sealed seed is never unsealed by a plaintext vault, nor opened by another kind", async () => {
    const path = join(freshDir(), "downgrade.db");
    const store = memoryStore();
    (await deviceIdentity(driverOn(path), { vault: createSecretStoreVault(store) })).unwrap();
    const row = await storedRow(path);
    const down = await deviceIdentity(driverOn(path), quiet);
    expect(down.isErr()).toBe(true);
    if (down.isErr()) expect(down.error.message).toContain("never unseals");
    const other = await deviceIdentity(driverOn(path), {
      vault: createSecretStoreVault(store, { kind: "other-keychain" }),
    });
    expect(other.isErr()).toBe(true);
    if (other.isErr()) expect(other.error.message).toContain("not by other-keychain");
    expect(await storedRow(path)).toBe(row);
  });

  test("a sealed row someone changed is a refusal, never a fresh key", async () => {
    const path = join(freshDir(), "tampered.db");
    const store = memoryStore();
    const vault = createSecretStoreVault(store);
    (await deviceIdentity(driverOn(path), { vault })).unwrap();
    const row = await storedRow(path);
    const flipped = `${row.slice(0, -2)}${row.endsWith("00") ? "01" : "00"}`;
    const driver = driverOn(path);
    await driver.run(`UPDATE "_device" SET "value" = ? WHERE "key" = 'seed'`, [flipped]);
    const opened = await deviceIdentity(driver, { vault });
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) expect(opened.error._tag).toBe("DeviceKeyUnavailable");
  });

  test("a vault that cannot open what it sealed fails the first boot and writes nothing", async () => {
    const forgetful = {
      kind: "forgetful",
      seal: (seed) => Promise.resolve(seed.map((b) => b ^ 0xff)),
      open: () => Promise.resolve(new Uint8Array(32)),
    } satisfies SeedVault;
    const driver = driverOn(":memory:");
    const opened = await deviceIdentity(driver, { vault: forgetful });
    expect(opened.isErr()).toBe(true);
    expect(await driver.all(`SELECT * FROM "_device"`)).toEqual([]);
  });

  test("two first boots at once on one device keep a key each opens", async () => {
    // two databases over one keychain, booting together: the slower boot's write of a key must
    // not replace the key the faster one already sealed its row under
    const dir = freshDir();
    const vault = createSecretStoreVault(slowSecondWrite(memoryStore()));
    const [a, b] = await Promise.all([
      deviceIdentity(driverOn(join(dir, "a.db")), { vault }),
      deviceIdentity(driverOn(join(dir, "b.db")), { vault }),
    ]);
    const again = await Promise.all([
      deviceIdentity(driverOn(join(dir, "a.db")), { vault }),
      deviceIdentity(driverOn(join(dir, "b.db")), { vault }),
    ]);
    expect(again.map((opened) => opened.unwrap().peerId)).toEqual([
      a.unwrap().peerId,
      b.unwrap().peerId,
    ]);
  });

  test("two first boots at once on one database: one wins, and its seed still opens", async () => {
    // two tabs over one file: the loser's insert fails, as before U4, and the winner's key stays
    const path = join(freshDir(), "tabs.db");
    const vault = createSecretStoreVault(slowSecondWrite(memoryStore()));
    const boots = await Promise.all([
      deviceIdentity(driverOn(path), { vault }),
      deviceIdentity(driverOn(path), { vault }),
    ]);
    const won = boots.filter((opened) => opened.isOk()).map((opened) => opened.value.peerId);
    const reboot = (await deviceIdentity(driverOn(path), { vault })).unwrap();
    expect(won).toEqual([reboot.peerId]);
  });

  test("a vault whose kind the row cannot carry is refused before anything is written", async () => {
    const colon = { ...createSecretStoreVault(memoryStore()), kind: "os:keychain" };
    const driver = driverOn(":memory:");
    const opened = await deviceIdentity(driver, { vault: colon });
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) expect(opened.error.message).toContain("letters, digits and -");
    expect(await driver.all(`SELECT name FROM sqlite_master WHERE name = '_device'`)).toEqual([]);
  });

  test("a store that keeps nothing fails the first boot", async () => {
    const leaky = { get: () => Promise.resolve(undefined), set: () => Promise.resolve() };
    const opened = await deviceIdentity(driverOn(":memory:"), {
      vault: createSecretStoreVault(leaky),
    });
    expect(opened.isErr()).toBe(true);
  });
});

describe("createWebCryptoVault", () => {
  /** A key holder in memory, where a browser has IndexedDB: the key object, never its bytes. */
  const heldKeys = () => {
    const keys = new Map<string, CryptoKey>();
    let writes = 0;
    return {
      keys,
      get: (name: string) => Promise.resolve(keys.get(name)),
      put: async (name: string, key: CryptoKey, slow = false) => {
        if (slow && writes++ > 0) await slowerKeychain();
        keys.set(name, key);
      },
    };
  };

  test("two first boots at once on one origin keep a key each opens", async () => {
    const holder = heldKeys();
    const slow = {
      get: holder.get,
      put: (name: string, key: CryptoKey) => holder.put(name, key, true),
    };
    const dir = freshDir();
    const vault = createWebCryptoVault(slow);
    const [a, b] = await Promise.all([
      deviceIdentity(driverOn(join(dir, "a.db")), { vault }),
      deviceIdentity(driverOn(join(dir, "b.db")), { vault }),
    ]);
    const again = await Promise.all([
      deviceIdentity(driverOn(join(dir, "a.db")), { vault }),
      deviceIdentity(driverOn(join(dir, "b.db")), { vault }),
    ]);
    expect(again.map((opened) => opened.unwrap().peerId)).toEqual([
      a.unwrap().peerId,
      b.unwrap().peerId,
    ]);
  });

  test("seals under a key no script can read, and opens across boots", async () => {
    const holder = heldKeys();
    const path = join(freshDir(), "web.db");
    const first = (
      await deviceIdentity(driverOn(path), { vault: createWebCryptoVault(holder) })
    ).unwrap();
    expect((await storedRow(path)).startsWith("sealed:webcrypto:")).toBe(true);
    const [key] = holder.keys.values();
    expect(key?.extractable).toBe(false);
    // the attack a script on the page would try: export the key and take it with the database
    if (key !== undefined) expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const again = (
      await deviceIdentity(driverOn(path), { vault: createWebCryptoVault(holder) })
    ).unwrap();
    expect(again.peerId).toBe(first.peerId);
  });

  test("another browser's key opens nothing", async () => {
    const path = join(freshDir(), "web-copied.db");
    (await deviceIdentity(driverOn(path), { vault: createWebCryptoVault(heldKeys()) })).unwrap();
    const elsewhere = await deviceIdentity(driverOn(path), {
      vault: createWebCryptoVault(heldKeys()),
    });
    expect(elsewhere.isErr()).toBe(true);
    if (elsewhere.isErr()) expect(elsewhere.error.message).toContain("copied from another device");
  });

  test("a cleared key store refuses rather than minting another identity", async () => {
    const path = join(freshDir(), "web-cleared.db");
    const holder = heldKeys();
    (await deviceIdentity(driverOn(path), { vault: createWebCryptoVault(holder) })).unwrap();
    const cleared = { get: () => Promise.resolve(undefined), put: () => Promise.resolve() };
    const opened = await deviceIdentity(driverOn(path), { vault: createWebCryptoVault(cleared) });
    expect(opened.isErr()).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
