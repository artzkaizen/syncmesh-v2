import { Result } from "@syncmesh/result";

import { randomBytes } from "./entropy.js";
import { bytesEqual, bytesToHex, hexToBytes } from "./hex.js";
import { openPayload, sealPayload } from "./sealing.js";

/**
 * Where a secret kept beside its data is kept safe at rest: the platform keystore that holds a key
 * the secret is sealed under. A device's seed (gaps U4), a relay room's seed and a Durable
 * Object's link keys (N26) all go through one.
 *
 * The sealed secret stays in its own database, so it is still gone when the database is (the
 * reason `deviceIdentity` keeps the seed there). What the keystore adds is that the file alone is
 * not the key: a copy of the database — a backup, a lost laptop's disk, a file another app read —
 * opens nothing without the keystore of the machine that sealed it.
 *
 * `seal` and `open` throw on failure; `deviceIdentity` turns a throw into `DeviceKeyUnavailable`.
 * `kind` is stored beside the sealed bytes, and a secret sealed by one kind is refused by another.
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
  /**
   * The prefix of the names the wrapping keys are kept under: each seal's key is
   * `<name>.<32 hex>`. Default `"syncmesh.device-seed-key"`.
   */
  readonly name?: string;
}

/** What a sealed seed is bound to, so the bytes cannot be taken for any other sealed value. */
const SEED_AAD = new TextEncoder().encode("syncmesh/device-seed/v1");

const WRAPPING_KEY_BYTES = 32;

/** How many bytes name a seal's own wrapping key; the first bytes of what every keystore vault seals. */
const KEY_ID_BYTES = 16;

/**
 * A fresh key id, and the name `prefix` gives it in a keystore.
 *
 * One key per seal, never one per device: two first boots on one device (two databases, or two
 * tabs over one) that shared a name would each mint a key under it, and the later write would
 * replace the key the earlier boot had already sealed its row under — a database whose seed no
 * key opens any more. A name of its own is a name no other seal can overwrite.
 */
const createKeyId = (prefix: string) => {
  const id = randomBytes(KEY_ID_BYTES);
  return { id, name: `${prefix}.${bytesToHex(id)}` };
};

/** The key id at the front of `sealed`, and the name `prefix` gives it. */
const splitSealed = (prefix: string, sealed: Uint8Array) => {
  if (sealed.length <= KEY_ID_BYTES)
    throw new Error("the sealed device seed is too short to name its key");
  const id = sealed.slice(0, KEY_ID_BYTES);
  return { body: sealed.slice(KEY_ID_BYTES), name: `${prefix}.${bytesToHex(id)}` };
};

/** `id` then `body`, as one array. */
const prefixed = (id: Uint8Array, body: Uint8Array) => {
  const out = new Uint8Array(id.length + body.length);
  out.set(id);
  out.set(body, id.length);
  return out;
};

/**
 * A seed sealed under a random 32-byte key that lives in a platform's secret store
 * (XChaCha20-Poly1305). Each seal mints its own key, under a name of its own (`<name>.<32 hex>`)
 * that the sealed bytes carry, and reads it back before it is used, so a store that does not keep
 * what it is given fails the first boot rather than a later one.
 *
 * A seal never writes a name another seal used, so concurrent first boots on one device cannot
 * take each other's key. A boot that seals and then loses the race for its database's row leaves
 * its key behind, unread.
 *
 * The store is read once per boot: a seal's read-back, which the boot's check of its own seal
 * reuses, or an open's one read. A store that asks for biometrics on a read therefore prompts
 * once at the first boot and once at every boot after it.
 *
 * @example
 * import { Entry } from "@napi-rs/keyring";
 * const vault = createSecretStoreVault({
 *   get: async (name) => new Entry("my-app", name).getPassword(),
 *   set: async (name, value) => new Entry("my-app", name).setPassword(value),
 * });
 */
export function createSecretStoreVault(
  store: SecretStore,
  options: SecretStoreVaultOptions = {},
): SeedVault {
  const prefix = options.name ?? "syncmesh.device-seed-key";
  const held = async (name: string) => {
    const text = await store.get(name);
    return text === null || text === undefined ? undefined : hexToBytes(text).unwrap();
  };
  // the keys this vault minted, as the store gave them back: a boot opening what it just sealed
  // reads the store once, which is one prompt where the store asks for biometrics on a read
  const minted = new Map<string, Uint8Array>();
  return {
    kind: options.kind ?? "secret-store",
    seal: async (seed) => {
      const { id, name } = createKeyId(prefix);
      await store.set(name, bytesToHex(randomBytes(WRAPPING_KEY_BYTES)));
      const key = await held(name);
      if (key === undefined) throw new Error(`the secret store did not keep ${name}`);
      minted.set(name, key);
      return prefixed(id, sealPayload(key, seed, SEED_AAD));
    },
    open: async (sealed) => {
      const { body, name } = splitSealed(prefix, sealed);
      const key = minted.get(name) ?? (await held(name));
      if (key === undefined)
        throw new Error(
          `the secret store holds no ${name}: this database was sealed on another device, or the store was cleared`,
        );
      return openPayload(key, body, SEED_AAD).unwrap();
    },
  };
}

/** Where {@link createWebCryptoVault} keeps its non-extractable key. */
export interface CryptoKeyHolder {
  readonly get: (name: string) => Promise<CryptoKey | undefined>;
  /** Keeps `key` under `name`; refuses, never overwrites, a name already held. */
  readonly put: (name: string, key: CryptoKey) => Promise<void>;
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
  readonly add: (value: CryptoKey, name: string) => KeyRequest<unknown>;
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
 * into with its non-extractable flag intact. `put` is IndexedDB's `add`, so a name already held
 * is a `ConstraintError`, never a replaced key.
 */
export function createIndexedDbKeyHolder(factory?: KeyStoreFactory): CryptoKeyHolder {
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
    get: async (name) => {
      const found = await within("readonly", (store) => store.get(name));
      return found instanceof CryptoKey ? found : undefined;
    },
    put: async (name, key) => {
      await within("readwrite", (store) => store.add(key, name));
    },
  };
}

/**
 * A seed sealed by WebCrypto under a non-extractable AES-GCM key (gaps U4): the browser holds the
 * key and no script, this one included, can read its bytes — only ask it to encrypt and decrypt.
 * The default vault wherever IndexedDB and `crypto.subtle` exist.
 *
 * Each seal mints its own key, kept in the origin's IndexedDB under `device-seed.<32 hex>`, the
 * name the sealed bytes carry, so concurrent first boots on one origin (two databases, or two
 * tabs over one) never replace each other's key. Clearing the site's data clears both. Clearing IndexedDB alone leaves a seed nobody can open, which the next boot
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
      const { id, name } = createKeyId("device-seed");
      await holder.put(
        name,
        await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
      );
      const key = await holder.get(name);
      if (key === undefined) throw new Error("the browser did not keep the device seed's key");
      const iv = new Uint8Array(randomBytes(IV_BYTES));
      const sealed = new Uint8Array(await subtle.encrypt(algorithm(iv), key, seed.slice()));
      return prefixed(id, prefixed(iv, sealed));
    },
    open: async (sealed) => {
      const { body, name } = splitSealed("device-seed", sealed);
      const key = await holder.get(name);
      if (key === undefined)
        throw new Error(
          "this browser holds no key for the device seed: its IndexedDB was cleared, or the database came from elsewhere",
        );
      const iv = body.slice(0, IV_BYTES);
      return new Uint8Array(await subtle.decrypt(algorithm(iv), key, body.slice(IV_BYTES)));
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

/**
 * A vault over one 32-byte key the platform hands the process rather than keeps in a keystore:
 * a Worker secret, a key a KMS unwrapped at start (N26). Sealed with XChaCha20-Poly1305, so the
 * database alone opens nothing; the key is the deployment's, and rotating it leaves every secret
 * it sealed unreadable, which an open then refuses rather than minting new ones.
 *
 * @example
 * const vault = createKeyVault(hexToBytes(env.RELAY_SEAL_KEY).unwrap());
 */
export function createKeyVault(
  key: Uint8Array,
  options: { readonly kind?: string } = {},
): SeedVault {
  if (key.length !== WRAPPING_KEY_BYTES)
    throw new Error(`a key vault takes a ${WRAPPING_KEY_BYTES}-byte key, not ${key.length} bytes`);
  return {
    kind: options.kind ?? "key",
    seal: (secret) => Promise.resolve(sealPayload(key, secret, SEED_AAD)),
    open: (sealed) => Promise.resolve(openPayload(key, sealed, SEED_AAD).unwrap()),
  };
}

/** What a sealed text names its vault by: letters, digits and `-`, so `sealed:<kind>:` splits back. */
export const VAULT_KIND = /^[A-Za-z0-9-]+$/;

/** The prefix of a sealed text; bare hex is plaintext. */
const SEALED = "sealed:";

/**
 * Sealed bytes as the text a database keeps: `sealed:<kind>:<hex>`, or bare hex for
 * {@link createPlaintextVault}, which is what a row from before any vault held.
 *
 * @example
 * sealedText(vault, await vault.seal(seed)); // "sealed:webcrypto:9f3c…"
 */
export const sealedText = (vault: SeedVault, sealed: Uint8Array): string =>
  vault.kind === PLAINTEXT_VAULT
    ? bytesToHex(sealed)
    : `${SEALED}${vault.kind}:${bytesToHex(sealed)}`;

/**
 * A {@link sealedText} back as the vault kind that wrote it and its bytes.
 *
 * @example
 * parseSealedText("sealed:key:00ff").unwrap(); // { kind: "key", bytes: Uint8Array [0, 255] }
 */
export function parseSealedText(text: string) {
  if (!text.startsWith(SEALED))
    return hexToBytes(text).map((bytes) => ({ kind: PLAINTEXT_VAULT, bytes }));
  const rest = text.slice(SEALED.length);
  const split = rest.indexOf(":");
  const kind = rest.slice(0, Math.max(split, 0));
  return hexToBytes(split < 0 ? "" : rest.slice(split + 1)).map((bytes) => ({ kind, bytes }));
}

/**
 * Seals `secret`, then opens what it sealed: a vault that cannot read its own seal back fails
 * here, at the first write, instead of at the next open.
 */
export const sealChecked = (vault: SeedVault, secret: Uint8Array) =>
  Result.tryPromise({
    try: async () => {
      const sealed = await vault.seal(secret);
      if (!bytesEqual(await vault.open(sealed), secret))
        throw new Error(`the ${vault.kind} vault does not open what it sealed`);
      return sealed;
    },
    catch: (cause) => cause,
  });
