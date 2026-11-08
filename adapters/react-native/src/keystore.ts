import type { SeedVault } from "@syncmesh/client";

import { createSecretStoreVault } from "@syncmesh/client";
import { requireOptionalNativeModule } from "expo";

/** The iOS `kSecAttrAccessible` constants the native module exports, by name. */
type Accessible = "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY" | "WHEN_UNLOCKED_THIS_DEVICE_ONLY";

/** What `expo-secure-store`'s native module answers to: the two calls its `getItemAsync`/`setItemAsync` make. */
interface SecureStoreNative extends Readonly<Record<Accessible, number>> {
  getValueWithKeyAsync(key: string, options: NativeOptions): Promise<string | null>;
  setValueWithKeyAsync(value: string, key: string, options: NativeOptions): Promise<void>;
}

interface NativeOptions {
  readonly keychainService?: string;
  readonly keychainAccessible?: number;
  readonly requireAuthentication?: boolean;
  readonly authenticationPrompt?: string;
}

/**
 * The native module itself, as `network.ts` reaches `ExpoNetwork`: `expo-secure-store`'s own entry
 * resolves its module at import and throws on a binary without it, which would take the mesh's
 * whole import graph down rather than refuse one open.
 */
const native = requireOptionalNativeModule<SecureStoreNative>("ExpoSecureStore");

export interface SecureStoreVaultOptions {
  /**
   * The prefix of the keychain items the wrapping keys are kept under: each seal's item is
   * `<name>.<32 hex>`. Default `"syncmesh.device-seed-key"`.
   */
  readonly name?: string;
  /** iOS `kSecAttrService` / Android key alias. Default: the module's own. */
  readonly keychainService?: string;
  /**
   * When the key may be read. Default `"AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY"`, which a mesh woken
   * in the background with the screen locked can still open; `"WHEN_UNLOCKED_THIS_DEVICE_ONLY"`
   * refuses those boots. Both keep the key out of backups and iCloud Keychain.
   */
  readonly accessible?: Accessible;
  /**
   * Ask for the device's biometrics or passcode before the key is read. Default `false`. A boot
   * reads the key once, so this is one prompt at the first boot and one at every boot after it.
   */
  readonly requireAuthentication?: boolean;
  readonly authenticationPrompt?: string;
}

/**
 * The device seed sealed under a key the iOS Keychain or Android Keystore holds, through
 * `expo-secure-store`'s native module (gaps U4).
 *
 * `THIS_DEVICE_ONLY` on purpose: a backup of the app's files restored onto another phone carries
 * the sealed seed and not the key, so that phone's first boot is refused (`DeviceKeyUnavailable`)
 * rather than a second install of this device. A binary built without `expo-secure-store` refuses
 * every open the same way, never falls back to plaintext.
 *
 * Keychain items outlive the app on iOS: an uninstall leaves each seal's item behind, and a
 * reinstall seals under a new one, so the old items are orphans nothing reads.
 *
 * @example
 * import { createSecureStoreVault } from "@syncmesh/react-native/keystore";
 *
 * const client = createClient({ schema, storage: sqlite({ driver }), vault: createSecureStoreVault() });
 */
export function createSecureStoreVault(options: SecureStoreVaultOptions = {}): SeedVault {
  const module = () => {
    if (native === null)
      throw new Error("this build has no expo-secure-store: install it and rebuild the binary");
    return native;
  };
  const nativeOptions = (store: SecureStoreNative): NativeOptions => ({
    keychainAccessible: store[options.accessible ?? "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY"],
    ...(options.keychainService !== undefined && { keychainService: options.keychainService }),
    ...(options.requireAuthentication !== undefined && {
      requireAuthentication: options.requireAuthentication,
    }),
    ...(options.authenticationPrompt !== undefined && {
      authenticationPrompt: options.authenticationPrompt,
    }),
  });
  return createSecretStoreVault(
    {
      get: (name) => {
        const store = module();
        return store.getValueWithKeyAsync(name, nativeOptions(store));
      },
      set: (name, value) => {
        const store = module();
        return store.setValueWithKeyAsync(value, name, nativeOptions(store));
      },
    },
    { kind: "secure-store", ...(options.name !== undefined && { name: options.name }) },
  );
}
