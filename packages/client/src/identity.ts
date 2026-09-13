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
const READ = `SELECT "value" FROM "_device" WHERE "key" = 'seed'`;
const WRITE = `INSERT INTO "_device" ("key", "value") VALUES ('seed', ?)`;

const unavailable = (message: string) => (cause: unknown) =>
  new DeviceKeyUnavailable({ message, cause });

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
    const seed = yield* await Result.tryPromise({
      try: async () => {
        await driver.run(CREATE);
        const held = await driver.all(READ);
        const value = held[0]?.[0];
        // the column is TEXT NOT NULL, so anything there is this install's key in hex
        if (value !== undefined && value !== null) return String(value);
        const fresh = bytesToHex(randomBytes(SEED_LENGTH));
        await driver.run(WRITE, [fresh]);
        return fresh;
      },
      catch: unavailable("this install's device key could not be read from its own database"),
    });
    const raw = yield* hexToBytes(seed).mapError(
      unavailable("this install's stored device key is not the 32 bytes a key is"),
    );
    return createIdentity(raw).mapError(
      unavailable("this install's stored device key is not the 32 bytes a key is"),
    );
  });
}
