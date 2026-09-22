import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";
import type { Identity } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import { bytesToHex, createIdentity, hexToBytes, randomBytes } from "@syncmesh/wire";

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

const unavailable = (message: string) => (cause: unknown) =>
  new DeviceKeyUnavailable({ message, cause });

/**
 * Reads one durable value of this install, minting it on the first ask.
 *
 * Shared by the key and the lineage because they are the same fact twice: both are true of *this
 * database* and neither may outlive it. A second table, or a second place, is how one of them
 * ends up describing a store that is gone.
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

/**
 * Asked of a driver rather than of a mesh, because the mesh cannot be built without the answer —
 * the identity is what signs its events. So this is the one table the client owns outside any
 * schema, written directly, before an engine exists over the same file.
 *
 * The bytes come from {@link randomBytes}, which is the `entropy` a caller passed or the
 * platform's own — and refuses rather than reaching for a weaker source, because a device key
 * drawn from one is forgeable and the forgery is undetectable afterwards.
 */
export function deviceIdentity(
  driver: SqlDriver,
): Promise<ResultType<Identity, DeviceKeyUnavailable>> {
  return Result.gen(async function* () {
    const seed = yield* await remembered(
      driver,
      "seed",
      "this install's device key could not be read from its own database",
    );
    const raw = yield* hexToBytes(seed).mapError(
      unavailable("this install's stored device key is not the 32 bytes a key is"),
    );
    return createIdentity(raw).mapError(
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
