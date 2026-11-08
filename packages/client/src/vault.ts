import { bytesToHex, hexToBytes, openPayload, randomBytes, sealPayload } from "@syncmesh/wire";

/**
 * Where this install's device seed is kept safe at rest (gaps U4): the platform keystore that
 * holds a key the seed is sealed under.
 *
 * The sealed seed stays in the device's own database, so it is still gone when the database is
 * (the reason `deviceIdentity` keeps it there). What the keystore adds is that the file alone is
 * not the key: a copy of the database — a backup, a lost laptop's disk, a file another app read —
 * opens nothing without the keystore of the device that sealed it.
 *
 * `seal` and `open` throw on failure; `deviceIdentity` turns a throw into `DeviceKeyUnavailable`.
 * `kind` is stored beside the sealed bytes, and a seed sealed by one kind is refused by another.
 */
export interface SeedVault {
  /** Stored with the sealed seed. Letters, digits and `-` only. */
  readonly kind: string;
  /** The seed as the bytes the database keeps. */
  readonly seal: (seed: Uint8Array) => Promise<Uint8Array>;
  /** The seed back from what {@link SeedVault.seal} returned; throws when this vault cannot. */
  readonly open: (sealed: Uint8Array) => Promise<Uint8Array>;
  /**
   * Said at every boot that opens a seed through this vault, through `deviceIdentity`'s
   * `onNotice`. Only {@link createPlaintextVault} has one.
   */
  readonly notice?: string;
}

/** The `kind` of {@link createPlaintextVault}: a seed stored as bare hex, as before U4. */
export const PLAINTEXT_VAULT = "plaintext";

/**
 * No keystore: the seed is stored as hex in the database, readable by anyone holding the file.
 *
 * For tests and development, and for a platform with no keystore where the file's own protection
 * is the only one there is. It must be asked for, and every boot through it says so.
 *
 * @example
 * const identity = (await deviceIdentity(driver, { vault: createPlaintextVault() })).unwrap();
 */
export const createPlaintextVault = (): SeedVault => ({
  kind: PLAINTEXT_VAULT,
  seal: (seed) => Promise.resolve(seed),
  open: (sealed) => Promise.resolve(sealed),
  notice:
    "DEVICE KEY IN PLAINTEXT: this install's signing seed is stored unencrypted in its database, so anyone with a copy of the file can sign as this device. Pass a keystore vault (createWebCryptoVault, createSecretStoreVault, @syncmesh/react-native/keystore) outside tests and development.",
});

/**
 * A string store a platform keystore offers: the iOS Keychain or Android Keystore through
 * `expo-secure-store`, the OS keychain on a desktop or server through a binding such as
 * `@napi-rs/keyring`. `get` answers `null` or `undefined` for a name never set.
 */
export interface SecretStore {
  readonly get: (name: string) => Promise<string | null | undefined>;
  readonly set: (name: string, value: string) => Promise<void>;
}

export interface SecretStoreVaultOptions {
  /** The vault's `kind`. Default `"secret-store"`. */
  readonly kind?: string;
  /** The name the wrapping key is kept under in the store. Default `"syncmesh.device-seed-key"`. */
  readonly name?: string;
}

/** What a sealed seed is bound to, so the bytes cannot be taken for any other sealed value. */
const SEED_AAD = new TextEncoder().encode("syncmesh/device-seed/v1");

const WRAPPING_KEY_BYTES = 32;

/**
 * A seed sealed under a random 32-byte key that lives in a platform's secret store
 * (XChaCha20-Poly1305). The key is minted at the first seal and read back before it is used, so a
 * store that does not keep what it is given fails the first boot rather than a later one.
 *
 * One key per store `name`: every database on the device seals under it.
 *
 * @example
 * import { Entry } from "@napi-rs/keyring";
 * const entry = new Entry("my-app", "syncmesh.device-seed-key");
 * const vault = createSecretStoreVault({
 *   get: async () => entry.getPassword(),
 *   set: async (_, value) => entry.setPassword(value),
 * });
 */
export function createSecretStoreVault(
  store: SecretStore,
  options: SecretStoreVaultOptions = {},
): SeedVault {
  const name = options.name ?? "syncmesh.device-seed-key";
  const held = async () => {
    const text = await store.get(name);
    return text === null || text === undefined ? undefined : hexToBytes(text).unwrap();
  };
  return {
    kind: options.kind ?? "secret-store",
    seal: async (seed) => {
      let key = await held();
      if (key === undefined) {
        await store.set(name, bytesToHex(randomBytes(WRAPPING_KEY_BYTES)));
        key = await held();
      }
      if (key === undefined) throw new Error(`the secret store did not keep ${name}`);
      return sealPayload(key, seed, SEED_AAD);
    },
    open: async (sealed) => {
      const key = await held();
      if (key === undefined)
        throw new Error(
          `the secret store holds no ${name}: this database was sealed on another device, or the store was cleared`,
        );
      return openPayload(key, sealed, SEED_AAD).unwrap();
    },
  };
}

/** Where {@link createWebCryptoVault} keeps its non-extractable key. */
export interface CryptoKeyHolder {
  readonly get: () => Promise<CryptoKey | undefined>;
  readonly put: (key: CryptoKey) => Promise<void>;
}

const IV_BYTES = 12;

/**
 * The slice of IndexedDB {@link createIndexedDbKeyHolder} uses, declared here because this
 * package compiles without the DOM library.
 */
interface KeyRequest<T> {
  readonly result: T;
  readonly error: unknown;
  readonly addEventListener: (type: "success" | "error" | "upgradeneeded", fn: () => void) => void;
}
interface KeyObjects {
  readonly get: (name: string) => KeyRequest<unknown>;
  readonly put: (value: CryptoKey, name: string) => KeyRequest<unknown>;
}
interface KeyDatabase {
  readonly createObjectStore: (name: string) => void;
  readonly transaction: (
    store: string,
    mode: "readonly" | "readwrite",
  ) => { readonly objectStore: (name: string) => KeyObjects };
  readonly close: () => void;
}

/** The `indexedDB` global, as far as a key holder needs it. */
export interface KeyStoreFactory {
  readonly open: (name: string, version: number) => KeyRequest<KeyDatabase>;
}

/** The runtime's `indexedDB`; a throw, which the boot reports, where there is none. */
const globalKeyStore = (): KeyStoreFactory => {
  // SAFETY: the global is the DOM's IDBFactory where it exists, and this reads only the slice
  // `KeyStoreFactory` declares of it; absent, it reads as `undefined`
  const factory = (globalThis as { readonly indexedDB?: KeyStoreFactory }).indexedDB;
  if (factory === undefined) throw new Error("this platform has no IndexedDB to keep the key in");
  return factory;
};

/** A request's result as a promise. */
const settled = <T>(request: KeyRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

/**
 * The origin's IndexedDB, database `syncmesh-keystore`: what a `CryptoKey` is structured-cloned
 * into with its non-extractable flag intact.
 */
export function createIndexedDbKeyHolder(
  factory?: KeyStoreFactory,
  name = "device-seed",
): CryptoKeyHolder {
  const STORE = "keys";
  const opened = () => {
    const request = (factory ?? globalKeyStore()).open("syncmesh-keystore", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore(STORE));
    return settled(request);
  };
  const within = async (
    mode: "readonly" | "readwrite",
    fn: (store: KeyObjects) => KeyRequest<unknown>,
  ) => {
    const db = await opened();
    const result = await settled(fn(db.transaction(STORE, mode).objectStore(STORE)));
    db.close();
    return result;
  };
  return {
    get: async () => {
      const found = await within("readonly", (store) => store.get(name));
      return found instanceof CryptoKey ? found : undefined;
    },
    put: async (key) => {
      await within("readwrite", (store) => store.put(key, name));
    },
  };
}

/**
 * A seed sealed by WebCrypto under a non-extractable AES-GCM key (gaps U4): the browser holds the
 * key and no script, this one included, can read its bytes — only ask it to encrypt and decrypt.
 * The default vault wherever IndexedDB and `crypto.subtle` exist.
 *
 * The key is per origin, in IndexedDB beside the database's own storage, so clearing the site's
 * data clears both. Clearing IndexedDB alone leaves a seed nobody can open, which the next boot
 * refuses as `DeviceKeyUnavailable` rather than minting another identity.
 */
export function createWebCryptoVault(
  holder: CryptoKeyHolder = createIndexedDbKeyHolder(),
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): SeedVault {
  const algorithm = (iv: Uint8Array<ArrayBuffer>) => ({
    name: "AES-GCM",
    iv,
    additionalData: SEED_AAD,
  });
  return {
    kind: "webcrypto",
    seal: async (seed) => {
      let key = await holder.get();
      if (key === undefined) {
        await holder.put(
          await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
        );
        key = await holder.get();
      }
      if (key === undefined) throw new Error("the browser did not keep the device seed's key");
      const iv = new Uint8Array(randomBytes(IV_BYTES));
      const sealed = new Uint8Array(await subtle.encrypt(algorithm(iv), key, seed.slice()));
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv);
      out.set(sealed, IV_BYTES);
      return out;
    },
    open: async (sealed) => {
      const key = await holder.get();
      if (key === undefined)
        throw new Error(
          "this browser holds no key for the device seed: its IndexedDB was cleared, or the database came from elsewhere",
        );
      const iv = sealed.slice(0, IV_BYTES);
      return new Uint8Array(await subtle.decrypt(algorithm(iv), key, sealed.slice(IV_BYTES)));
    },
  };
}

/**
 * The vault this platform offers without being asked: {@link createWebCryptoVault} where
 * IndexedDB and `crypto.subtle` exist (a browser, a worker), `undefined` elsewhere — React Native,
 * Bun and Node have no keystore in reach of a library without a native module.
 */
export const platformVault = (): SeedVault | undefined =>
  "indexedDB" in globalThis && globalThis.crypto?.subtle !== undefined
    ? createWebCryptoVault()
    : undefined;
