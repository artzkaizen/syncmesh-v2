import type { SqlDriver } from "@syncmesh/storage";
import type { Identity } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import { SEED_LENGTH, bytesToHex, createIdentity, hexToBytes } from "@syncmesh/wire";

/**
 * Who this install is, and who vouched for it.
 *
 * One file rather than a constant in each thread, because the worker signs every event with the
 * key below and every tab names the account below on every write it asks for. A second copy of
 * either would be a second device wearing this one's face, and the log is the place that would
 * say so.
 *
 * **The device key is generated once per install and then read back from the database.** It used
 * to come from a fixed seed, which was the honest answer while `transports: []` meant no second
 * device existed to lie to. A relay makes one exist, and a bundled key makes every install of
 * this app the *same author*: two browsers publishing two divergent `(author, seq)` streams into
 * one log, where the loser's writes are not rejected but silently dropped as already-seen. So the
 * key is per install. What a fixed seed was protecting against — a new author on every reload,
 * which turns one person's log into a crowd of strangers — is answered by persisting it rather
 * than by sharing it.
 */

/** Demo keys, derived from fixed seeds rather than generated. */
const bytes = (n: number) => Uint8Array.from({ length: 32 }, (_, index) => (n + index) % 256);

/**
 * **The issuer's private half is in this bundle, and that is not production-safe.**
 *
 * Said plainly because the rest of this app is careful, and a reader who sees a device key
 * generated per install and persisted might reasonably assume the grant beside it is too. It is
 * not: every install of this build mints its own grant locally from the key below, which means
 * every install can mint a grant for anybody. In a real deployment step ② of flow A is a **round
 * trip** — the device asks, an authority that holds this key alone decides, and what comes back is
 * bytes the device could not have produced. `mesh.requestGrant()` is the ask, and the relay
 * carries it: nothing else in `mesh-worker.ts` would change.
 *
 * It is kept rather than handed to the relay because a relay that issued grants would be a *worse*
 * lie — it would look like the round trip without being one. A relay holds no issuer key and
 * verifies nothing (see `createGrantCache`); it forwards grants it cannot read. Minting here, in
 * the open, at least puts the shortcut where somebody reading the demo will find it.
 *
 * The two installs sharing one issuer is what makes them recognise each other's grants, which is
 * exactly what one authority does for two of its devices.
 */
export const issuer = createIdentity(bytes(1)).unwrap();

/** Ada, who is an admin — the seed attributes its comments to her, and only an admin may seed. */
export const ACTOR = "acct_ada";

/**
 * This install's key could not be read or written, so it has no stable name to sign under.
 *
 * Fatal on purpose, and not recoverable by generating one: a device that made a fresh key every
 * time it failed to read the old one would author under a new name on every reload, which is the
 * crowd-of-strangers log this whole file exists to prevent.
 */
export class DeviceKeyUnavailable extends TaggedError("DeviceKeyUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * One row, in the same database the log is in.
 *
 * **Not local storage, and for the same reason the seed counts issues instead of setting a flag:**
 * a key kept beside the database outlives the database it describes. Clear the OPFS file and
 * `localStorage` still names an author whose whole log is gone — so the device would rejoin the
 * room claiming a sequence it can no longer produce, and the relay would hand it back events it
 * is supposed to have written. A key in the file is gone when the file is, which is the truth.
 */
const CREATE = `CREATE TABLE IF NOT EXISTS "_device" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`;
const READ = `SELECT "value" FROM "_device" WHERE "key" = 'seed'`;
const WRITE = `INSERT INTO "_device" ("key", "value") VALUES ('seed', ?)`;

const unavailable = (message: string) => (cause: unknown) =>
  new DeviceKeyUnavailable({ message, cause });

/**
 * This install's device key: read from the database, or generated into it on the first boot.
 *
 * Asked of a driver rather than of the mesh because the mesh cannot be built without the answer —
 * `createApp` takes the identity that will sign its events. So the one table this app owns outside
 * its schema is written directly, before an engine exists over the same file.
 *
 * There is no race between two tabs: only the worker that won the origin's election is ever handed
 * a port, so only one thread of this origin ever reaches here (`mesh-worker.ts`). A second *browser
 * profile* is a second origin with a second file, which is the whole point — it gets its own key.
 */
export function deviceIdentity(driver: SqlDriver): Promise<Result<Identity, DeviceKeyUnavailable>> {
  return Result.gen(async function* () {
    const seed = yield* await Result.tryPromise({
      try: async () => {
        await driver.run(CREATE);
        const held = await driver.all(READ);
        const value = held[0]?.[0];
        // the column is TEXT NOT NULL, so anything there is this install's key in hex
        if (value !== undefined && value !== null) return String(value);
        const fresh = bytesToHex(crypto.getRandomValues(new Uint8Array(SEED_LENGTH)));
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
