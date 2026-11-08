import type { SeedVault } from "@syncmesh/client";

import { deviceIdentity } from "@syncmesh/client";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { describe, expect, mock, test } from "bun:test";

/**
 * The phone's keystore vault (gaps U4) on the two answers `requireOptionalNativeModule` gives:
 * the native module, standing in for the Keychain, or nothing on a binary built without it.
 * `expo` is stubbed as `absent-native.test.ts` explains.
 */

interface KeystoreExports {
  readonly createSecureStoreVault: (options?: {
    readonly accessible?: "WHEN_UNLOCKED_THIS_DEVICE_ONLY";
  }) => SeedVault;
}

/** The options the vault passes the native module. */
interface Written {
  readonly keychainAccessible?: number;
}

/** One phone's keychain: the items and the options each was written with. */
const keychain = () => {
  const items = new Map<string, string>();
  const written: { readonly key: string; readonly options: Written }[] = [];
  return {
    items,
    written,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 8,
    getValueWithKeyAsync: (key: string) => Promise.resolve(items.get(key) ?? null),
    setValueWithKeyAsync: (value: string, key: string, options: Written) => {
      written.push({ key, options });
      items.set(key, value);
      return Promise.resolve();
    },
  };
};

const withModule = async (answer: ReturnType<typeof keychain> | null) => {
  void mock.module("expo", () => ({ requireOptionalNativeModule: () => answer }));
  // SAFETY: the query string is ignored by the loader and the module resolved is `../keystore.js`
  return (await import(`../keystore.js?case=${String(Math.random())}`)) as KeystoreExports;
};

describe("createSecureStoreVault", () => {
  test("seals the seed under a keychain item kept on this device only", async () => {
    const phone = keychain();
    const { createSecureStoreVault } = await withModule(phone);
    const driver = bunSqliteDriver(":memory:");
    const first = (await deviceIdentity(driver, { vault: createSecureStoreVault() })).unwrap();
    expect(phone.written).toHaveLength(1);
    expect(phone.written[0]?.key).toMatch(/^syncmesh\.device-seed-key\.[0-9a-f]{32}$/);
    expect(phone.written[0]?.options).toEqual({ keychainAccessible: 7 });
    const [row] = await driver.all(`SELECT "value" FROM "_device" WHERE "key" = 'seed'`);
    expect(String(row?.[0]).startsWith("sealed:secure-store:")).toBe(true);
    const again = (await deviceIdentity(driver, { vault: createSecureStoreVault() })).unwrap();
    expect(again.peerId).toBe(first.peerId);
  });

  test("a backup restored onto another phone opens no key", async () => {
    const { createSecureStoreVault } = await withModule(keychain());
    const driver = bunSqliteDriver(":memory:");
    (await deviceIdentity(driver, { vault: createSecureStoreVault() })).unwrap();
    // the files travel; a THIS_DEVICE_ONLY item does not
    const other = await withModule(keychain());
    const restored = await deviceIdentity(driver, { vault: other.createSecureStoreVault() });
    expect(restored.isErr()).toBe(true);
  });

  test("a binary without expo-secure-store refuses the open, and never writes plaintext", async () => {
    const { createSecureStoreVault } = await withModule(null);
    const driver = bunSqliteDriver(":memory:");
    const opened = await deviceIdentity(driver, { vault: createSecureStoreVault() });
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) expect(opened.error._tag).toBe("DeviceKeyUnavailable");
    expect(await driver.all(`SELECT * FROM "_device"`)).toEqual([]);
  });

  test("the stricter accessibility is passed through", async () => {
    const phone = keychain();
    const { createSecureStoreVault } = await withModule(phone);
    const vault = createSecureStoreVault({ accessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" });
    (await deviceIdentity(bunSqliteDriver(":memory:"), { vault })).unwrap();
    expect(phone.written[0]?.options).toEqual({ keychainAccessible: 8 });
  });
});
