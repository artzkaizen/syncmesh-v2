import type { SqlDriver } from "@syncmesh/storage";
import type { Identity, SeedVault } from "@syncmesh/wire";

import { Result, panic } from "@syncmesh/result";
import { overwritePlaintext } from "@syncmesh/storage";
import {
  PLAINTEXT_VAULT,
  VAULT_KIND,
  createIdentity,
  parseSealedText,
  randomBytes,
  sealChecked,
  sealedText,
} from "@syncmesh/wire";

/** The relay's own facts beside the log: its lineage, and the secrets it keeps sealed. */
const META_DDL = `CREATE TABLE IF NOT EXISTS "_relay_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`;
const READ = `SELECT "value" FROM "_relay_meta" WHERE "key" = ?`;
const WRITE = `INSERT INTO "_relay_meta" ("key", "value") VALUES (?, ?)`;
const UPDATE = `UPDATE "_relay_meta" SET "value" = ? WHERE "key" = ?`;

/** One `_relay_meta` value as stored, or `undefined` when the key was never set. */
const storedMeta = async (driver: SqlDriver, key: string): Promise<string | undefined> => {
  await driver.run(META_DDL);
  const value = (await driver.all(READ, [key]))[0]?.[0];
  // the column is TEXT NOT NULL, so anything there is what the relay wrote
  return value === undefined || value === null ? undefined : String(value);
};

/** The epoch rides in the log's own file: a new file is honestly a new lineage. */
export const relayEpoch = async (driver: SqlDriver): Promise<string> => {
  const held = await storedMeta(driver, "epoch");
  if (held !== undefined) return held;
  const fresh = crypto.randomUUID();
  await driver.run(WRITE, ["epoch", fresh]);
  return fresh;
};

/** How a relay keeps the secrets it stores beside its log (N26). */
export interface RelaySecretOptions {
  /**
   * What seals each secret at rest: `createKeyVault` over a key the platform hands the process (a
   * Worker secret), `createSecretStoreVault` over an OS keychain, or `createPlaintextVault()` for
   * tests and development, which every open says.
   */
  readonly vault: SeedVault;
  /** Where the plaintext vault's notice and a migration's report go. Default `console.warn`. */
  readonly onNotice?: (message: string) => void;
}

// a panic thrown inside a `match` arm reaches the caller as "match err handler threw", so each
// refusal here is checked and thrown with its own message
const sealed = async (vault: SeedVault, secret: Uint8Array, what: string) => {
  const done = await sealChecked(vault, secret);
  if (done.isErr())
    panic(`the ${vault.kind} vault could not seal the relay's ${what}: ${String(done.error)}`);
  return done.value;
};

/**
 * A 32-byte secret kept in `_relay_meta` under `key`, sealed by `vault` (N26): minted and sealed
 * on the first open, sealed in place when an earlier build left it as plaintext hex (with its old
 * bytes scrubbed from free pages and the WAL, or a notice saying they may remain), and opened
 * on every open after. Throws when it cannot be: a secret sealed by another vault kind, or one
 * this vault's key no longer opens, is refused rather than replaced, since a replaced key is a
 * new name for the room and a new key for every link it resumes.
 *
 * @example
 * const key = await relaySecret(driver, "attachment-key", { vault: createKeyVault(secret) });
 */
export async function relaySecret(
  driver: SqlDriver,
  key: string,
  { vault, onNotice }: RelaySecretOptions,
): Promise<Uint8Array> {
  const notice =
    onNotice ??
    // oxlint-disable-next-line no-console -- the default for a host that routes no onNotice: a plaintext key must be said somewhere
    ((message: string) => console.warn(`[syncmesh relay] ${message}`));
  if (!VAULT_KIND.test(vault.kind))
    panic(`a vault's kind is letters, digits and - only, and "${vault.kind}" is not`);
  if (vault.kind === PLAINTEXT_VAULT)
    notice(
      `RELAY SECRET IN PLAINTEXT: the relay's ${key} is stored unencrypted beside its log, so anyone with a copy of it holds the secret. Pass a vault (createKeyVault over a platform secret, createSecretStoreVault over a keychain) outside tests and development.`,
    );
  const held = await storedMeta(driver, key);
  if (held === undefined) {
    const fresh = randomBytes(32);
    await driver.run(WRITE, [key, sealedText(vault, await sealed(vault, fresh, key))]);
    return fresh;
  }
  const parsed = parseSealedText(held);
  if (parsed.isErr()) panic(`the relay's stored ${key} is not a sealed or a hex secret`);
  const stored = parsed.value;
  if (stored.kind === PLAINTEXT_VAULT && vault.kind !== PLAINTEXT_VAULT) {
    // a secret from before the vault: sealed now, the plaintext row overwritten in place, and its
    // old bytes scrubbed from free pages and the WAL where the database lets them be
    const residue = await overwritePlaintext(
      driver,
      UPDATE,
      [sealedText(vault, await sealed(vault, stored.bytes, key)), key],
      `relay ${key}`,
    );
    notice(`moved the relay's ${key} out of plaintext, sealed by the ${vault.kind} vault`);
    if (residue !== undefined) notice(residue);
    return stored.bytes;
  }
  if (stored.kind !== vault.kind)
    panic(
      `the relay's ${key} is sealed by the ${stored.kind} vault, not by ${vault.kind}: pass that vault`,
    );
  const opened = await Result.tryPromise({
    try: () => vault.open(stored.bytes),
    catch: (cause) => cause,
  });
  if (opened.isErr())
    panic(
      `the ${vault.kind} vault cannot open the relay's ${key}: its key changed, or the database came from elsewhere (${String(opened.error)})`,
    );
  return opened.value;
}

/**
 * The key a room signs its link hello with (D36), kept beside the epoch so the room has one name
 * across restarts, evictions and moves — the name a client pins. Minted on the first open, and
 * sealed at rest by `options.vault` (N26).
 */
export async function relayIdentity(
  driver: SqlDriver,
  options: RelaySecretOptions,
): Promise<Identity> {
  const seed = await relaySecret(driver, "identity-seed", options);
  const identity = createIdentity(seed);
  if (identity.isErr())
    panic(`the relay's stored key could not be read: ${identity.error.message}`);
  return identity.value;
}
