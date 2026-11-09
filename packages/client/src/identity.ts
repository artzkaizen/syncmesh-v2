import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";
import type { Identity } from "@syncmesh/wire";
import type { SeedVault } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import {
  PLAINTEXT_VAULT,
  VAULT_KIND,
  bytesToHex,
  createIdentity,
  parseSealedText,
  platformVault,
  randomBytes,
  sealChecked,
  sealedText,
} from "@syncmesh/wire";

/**
 * This install's signing key: read from its own database, or minted into it on the first boot.
 *
 * **Device identity is the library's problem** (book ch. 8), and it was an app's for exactly as
 * long as it took one app to get it wrong. A build that shipped a fixed key made every install of
 * it the same author: two profiles wrote under one name, allocated `(author, seq)` from two
 * sequences, and the loser's writes were dropped as stale rather than refused — the silent
 * corruption a log has no way to report, because nothing about it is invalid.
 *
 * **In the database, never beside it.** A key in `localStorage` outlives the database it
 * describes: clear the storage a mesh lives in and the key still names an author whose whole log
 * is gone, so the device rejoins claiming a sequence it can no longer produce and is handed back
 * events it is supposed to have written. A key in the file is gone when the file is, which is the
 * only version of this fact that stays true.
 *
 * **Sealed, not bare** (gaps U4). The row holds the seed as a {@link SeedVault} sealed it, under a
 * key the platform's keystore keeps, so a copy of the file is not a copy of the key.
 */

/** How many bytes an Ed25519 seed is; the whole of what is stored. */
const SEED_LENGTH = 32;

/**
 * This install's key could not be read or written, so it has no stable name to sign under.
 *
 * Fatal on purpose, and **not** recoverable by minting a fresh one: a device that made a new key
 * every time it failed to read the old one would author under a new name on every start, which is
 * the crowd-of-strangers log this whole module exists to prevent. It is also how a run of writes
 * gets stranded — see `StrandedWrites`.
 */
export class DeviceKeyUnavailable extends TaggedError("DeviceKeyUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

const CREATE = `CREATE TABLE IF NOT EXISTS "_device" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`;
const READ = `SELECT "value" FROM "_device" WHERE "key" = ?`;
const WRITE = `INSERT INTO "_device" ("key", "value") VALUES (?, ?)`;
const UPDATE = `UPDATE "_device" SET "value" = ? WHERE "key" = ?`;

const unavailable = (message: string) => (cause: unknown) =>
  new DeviceKeyUnavailable({ message, cause });

/**
 * Reads one durable value of this install, minting it on the first ask.
 *
 * In the same table as the key because they are the same fact twice: both are true of *this
 * database* and neither may outlive it. A second table, or a second place, is how one of them
 * ends up describing a store that is gone. The lineage is no secret, so it is not sealed.
 */
const remembered = (driver: SqlDriver, key: string, message: string) =>
  Result.tryPromise({
    try: async () => {
      await driver.run(CREATE);
      const held = await driver.all(READ, [key]);
      const value = held[0]?.[0];
      // the column is TEXT NOT NULL, so anything there is what this install wrote
      if (value !== undefined && value !== null) return String(value);
      const fresh = bytesToHex(randomBytes(SEED_LENGTH));
      await driver.run(WRITE, [key, fresh]);
      return fresh;
    },
    catch: unavailable(message),
  });

export interface DeviceIdentityOptions {
  /**
   * Where the seed is sealed at rest (gaps U4). Default {@link platformVault}: WebCrypto in a
   * browser; elsewhere there is none, and the open is refused until one is passed —
   * `@syncmesh/react-native/keystore` on a phone, {@link createSecretStoreVault} over an OS
   * keychain, or {@link createPlaintextVault} for tests and development.
   */
  readonly vault?: SeedVault;
  /** Where a vault's boot notice and a migration's report go. Default `console.warn`. */
  readonly onNotice?: (message: string) => void;
}

/** Seals, then opens what it sealed: a vault that cannot read back fails the boot that minted. */
const sealSeed = (vault: SeedVault, seed: Uint8Array) =>
  sealChecked(vault, seed).then((sealed) =>
    sealed.mapError(
      unavailable(`the ${vault.kind} vault could not seal this install's device key`),
    ),
  );

const SECURE_DELETE = "PRAGMA secure_delete";

/**
 * Overwrites a plaintext seed with its sealed form, with SQLite's `secure_delete` on for the one
 * statement so the old bytes are zeroed in the page rather than left in free space, and then
 * checkpoints the WAL so no frame still holds them. Answers what it could not make sure of.
 */
async function replacePlaintext(driver: SqlDriver, row: string): Promise<string | undefined> {
  const before = await Result.tryPromise({
    try: async () => (await driver.all(SECURE_DELETE))[0]?.[0],
    catch: (cause) => cause,
  });
  if (before.isOk()) await driver.run(`${SECURE_DELETE} = ON`);
  await driver.run(UPDATE, [row, "seed"]);
  if (before.isOk()) await driver.run(`${SECURE_DELETE} = ${Number(before.value ?? 0)}`);
  const checkpoint = await Result.tryPromise({
    try: () => driver.all("PRAGMA wal_checkpoint(TRUNCATE)"),
    catch: (cause) => cause,
  });
  if (before.isErr())
    return "this database refuses PRAGMA secure_delete, so the plaintext seed's old bytes may stay in its free pages until they are reused";
  if (checkpoint.isErr() || Number(checkpoint.value[0]?.[0] ?? 0) !== 0)
    return "the WAL could not be checkpointed, so a frame of it may hold the plaintext seed until the next checkpoint";
  return undefined;
}

/**
 * The seed behind this install's `"seed"` row, minted and sealed on the first boot, and moved out
 * of plaintext when the row predates the vault.
 */
async function rememberedSeed(
  driver: SqlDriver,
  vault: SeedVault,
  notice: (message: string) => void,
): Promise<ResultType<Uint8Array, DeviceKeyUnavailable>> {
  return Result.gen(async function* () {
    const held = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          await driver.run(CREATE);
          const value = (await driver.all(READ, ["seed"]))[0]?.[0];
          return value === undefined || value === null ? undefined : String(value);
        },
        catch: unavailable("this install's device key could not be read from its own database"),
      }),
    );
    if (held === undefined) {
      const fresh = randomBytes(SEED_LENGTH);
      const sealed = yield* Result.await(sealSeed(vault, fresh));
      yield* Result.await(
        Result.tryPromise({
          try: () => driver.run(WRITE, ["seed", sealedText(vault, sealed)]),
          catch: unavailable("this install's device key could not be written to its own database"),
        }),
      );
      return Result.ok(fresh);
    }
    const stored = yield* parseSealedText(held).mapError(
      unavailable("this install's stored device key is not the 32 bytes a key is"),
    );
    if (stored.kind === PLAINTEXT_VAULT && vault.kind !== PLAINTEXT_VAULT) {
      // a seed from before the vault: sealed now, and the plaintext row overwritten in place
      const sealed = yield* Result.await(sealSeed(vault, stored.bytes));
      const residue = yield* Result.await(
        Result.tryPromise({
          try: () => replacePlaintext(driver, sealedText(vault, sealed)),
          catch: unavailable(
            "this install's plaintext device key could not be replaced by its sealed form",
          ),
        }),
      );
      notice(`moved this install's device key out of plaintext, sealed by the ${vault.kind} vault`);
      if (residue !== undefined) notice(residue);
      return Result.ok(stored.bytes);
    }
    if (stored.kind !== vault.kind)
      return Result.err(
        new DeviceKeyUnavailable({
          message:
            vault.kind === PLAINTEXT_VAULT
              ? `this install's device key is sealed by the ${stored.kind} vault, and a plaintext vault never unseals one: pass that vault`
              : `this install's device key is sealed by the ${stored.kind} vault, not by ${vault.kind}`,
        }),
      );
    const opened = Result.tryPromise({
      try: () => vault.open(stored.bytes),
      catch: unavailable(
        `the ${vault.kind} vault cannot open this install's device key: the database was copied from another device, or the keystore lost its key`,
      ),
    });
    return Result.ok(yield* Result.await(opened));
  });
}

/**
 * Asked of a driver rather than of a mesh, because the mesh cannot be built without the answer —
 * the identity is what signs its events. So this is the one table the client owns outside any
 * schema, written directly, before an engine exists over the same file.
 *
 * The seed is sealed by `options.vault` before it is written (gaps U4), and a seed stored in
 * plaintext by an earlier build is sealed and overwritten at the first boot with a vault. With no
 * vault and none on the platform (Bun, Node, React Native) the open is refused: plaintext is
 * {@link createPlaintextVault}, asked for by name, and said at every boot.
 *
 * The bytes come from {@link randomBytes}, which is the `entropy` a caller passed or the
 * platform's own — and refuses rather than reaching for a weaker source, because a device key
 * drawn from one is forgeable and the forgery is undetectable afterwards.
 */
export function deviceIdentity(
  driver: SqlDriver,
  options: DeviceIdentityOptions = {},
): Promise<ResultType<Identity, DeviceKeyUnavailable>> {
  const notice =
    options.onNotice ??
    // oxlint-disable-next-line no-console -- the default for an app that routes no onNotice: a plaintext key must be said somewhere
    ((message: string) => console.warn(`[syncmesh] ${message}`));
  return Result.gen(async function* () {
    const vault = options.vault ?? platformVault();
    if (vault === undefined)
      return Result.err(
        new DeviceKeyUnavailable({
          message:
            "no keystore on this platform for the device key: pass `vault` (@syncmesh/react-native/keystore, createSecretStoreVault over an OS keychain), or createPlaintextVault() for tests and development",
        }),
      );
    if (!VAULT_KIND.test(vault.kind))
      return Result.err(
        new DeviceKeyUnavailable({
          message: `a vault's kind is letters, digits and - only, and "${vault.kind}" is not: the row it sealed could not be read back`,
        }),
      );
    const seed = yield* Result.await(rememberedSeed(driver, vault, notice));
    // said once the seed is open through this vault: one refused over a sealed row holds no key
    if (vault.notice !== undefined) notice(vault.notice);
    return createIdentity(seed).mapError(
      unavailable("this install's stored device key is not the 32 bytes a key is"),
    );
  });
}

/**
 * This store's **incarnation**: the lineage a custody receipt signs over (D28).
 *
 * A peer's name says who it is; this says which of its databases is talking. Lose the store and
 * rebuild it and the incarnation is fresh, so every vouch made with the store that is gone stops
 * counting — which is the difference between *still holding* and *holding again, having lost what
 * it had*, and the only reason an author can tell them apart.
 *
 * **It earns its keep on the peers whose key outlives their storage**, which is most of the ones
 * an app leans on for durability: a device mints a new key with a new database (the key lives in
 * the file, see above), but a relay or an authority is configured with a keypair and redeployed
 * over an empty volume under the same name. Without this, that relay goes on counting as a holder
 * of writes it threw away.
 *
 * Minted rather than derived from the file's contents: nothing here needs to be a function of the
 * data, only different from the last one, and randomness is the only version of that which
 * survives a store rebuilt from an identical backup.
 */
export function deviceIncarnation(
  driver: SqlDriver,
): Promise<ResultType<string, DeviceKeyUnavailable>> {
  return remembered(
    driver,
    "incarnation",
    "this install's storage lineage could not be read from its own database",
  );
}
