import type { Brand } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { Result, TaggedError } from "@syncmesh/result";
import { bytesToHex } from "@syncmesh/wire";

import type { SqlDriver } from "./driver.js";

import { dialectOf, logTable, namespaceDdl, placementOf } from "./dialect.js";
import { attempt } from "./sql.js";

/**
 * Bytes that do not belong in a log (D18): a photo in the event log blocks convergence for
 * everything behind it and replicates to every peer forever. So a row carries the sha-256 and
 * the bytes travel on their own channel, content-addressed — the hash *is* the identity, which
 * makes a put idempotent, a re-upload after a loss free, and two rows referencing one photo
 * reference one set of bytes.
 */

/** A blob's identity: the lowercase hex sha-256 of its bytes, and nothing else about it. */
export type BlobHash = Brand<string, "BlobHash">;

/** The bytes do not hash to the name they arrived under — junk trying to squat a hash. */
export class BlobCorrupt extends TaggedError("BlobCorrupt")<{
  hash: string;
  message: string;
}> {}

/** Nobody reachable holds these bytes. Recoverable: any peer that still has them can put them back. */
export class BlobNotFound extends TaggedError("BlobNotFound")<{
  hash: string;
  message: string;
}> {}

/** The fetch outlived its deadline; the reference is still good, the route was not. */
export class BlobTimeout extends TaggedError("BlobTimeout")<{ hash: string; message: string }> {}

export type BlobError = BlobCorrupt | BlobNotFound | BlobTimeout;

/** The sha-256 of the bytes, in the wire's lowercase hex — the blob's whole identity. */
export const hashOf = (bytes: Uint8Array): BlobHash =>
  // SAFETY: bytesToHex emits lowercase hex, which is exactly the BlobHash invariant
  bytesToHex(sha256(bytes)) as BlobHash;

/**
 * The bytes back, only if they are the ones the hash names. A reference is a **proof** of
 * content, not a promise about whoever served it, so this runs on every fetch and every put —
 * a relay that skipped it would let anyone poison any hash.
 */
export const verifyBlob = (hash: BlobHash, bytes: Uint8Array): Result<Uint8Array, BlobCorrupt> =>
  hashOf(bytes) === hash
    ? Result.ok(bytes)
    : Result.err(
        new BlobCorrupt({
          hash: String(hash),
          message: "the bytes are not the ones this hash names",
        }),
      );

/** Where bytes live at one hop — a relay's durable home, or a device's evictable cache (D18). */
export interface BlobStore {
  /**
   * Stores the bytes under their own hash and returns it; storing twice is storing once.
   *
   * **This device made these**, which is what makes them irreplaceable: nobody else has them yet,
   * so evicting them loses them and a backup that skips them is not a backup. See {@link origin}.
   */
  readonly put: (bytes: Uint8Array) => Promise<Result<BlobHash, BlobError>>;
  /**
   * Stores bytes that arrived under a name, verifying **before** storing so junk cannot squat it.
   *
   * **These came from somewhere**, so they are a cache: whoever sent them still has them, and
   * dropping them costs a fetch rather than the bytes.
   */
  readonly putAt: (hash: BlobHash, bytes: Uint8Array) => Promise<Result<void, BlobError>>;
  readonly get: (hash: BlobHash) => Promise<Result<Uint8Array, BlobError>>;
  readonly has: (hash: BlobHash) => Promise<boolean>;
  /** Forgets these bytes here; a store that is a cache may do this whenever it likes. */
  readonly delete: (hash: BlobHash) => Promise<void>;
  /**
   * Where these bytes came from, which is the whole of what may be dropped and what may not.
   *
   * `undefined` for bytes this store does not hold. A store with no answer — the in-memory one —
   * reports everything as `mine`, which is the safe direction: it never licenses an eviction.
   */
  readonly origin: (hash: BlobHash) => Promise<BlobOrigin | undefined>;
  /**
   * Every hash this device is the only holder of — what a backup must include, and what an
   * eviction sweep must leave alone (RFC-0022).
   *
   * The complement is the cache: bytes that arrived under a name, which whoever sent them still
   * has. Moving blobs out of the log relocates the backup obligation rather than removing it,
   * and this is the list that says which half of them it is.
   */
  readonly irreplaceable: () => Promise<readonly BlobHash[]>;
}

/**
 * Whether these bytes exist anywhere else.
 *
 * `mine` is a local creation that has not been handed to anyone: the only copy. `cached` arrived
 * under its name from a peer that still holds it, so it can be fetched again and is free to drop
 * under pressure. The distinction is not a policy — it is which method stored them.
 */
export type BlobOrigin = "mine" | "cached";

const missing = (hash: BlobHash) =>
  Result.err(new BlobNotFound({ hash: String(hash), message: "no bytes here under that hash" }));

/** A store that lives as long as the process: a device's cache, and what tests run against. */
export function memoryBlobStore(): BlobStore {
  const held = new Map<string, Uint8Array>();
  return {
    put: (bytes) => {
      const hash = hashOf(bytes);
      held.set(hash, Uint8Array.from(bytes));
      return Promise.resolve(Result.ok(hash));
    },
    putAt: (hash, bytes) =>
      Promise.resolve(
        verifyBlob(hash, bytes).map(() => void held.set(hash, Uint8Array.from(bytes))),
      ),
    get: (hash) => {
      const bytes = held.get(hash);
      return Promise.resolve(bytes === undefined ? missing(hash) : verifyBlob(hash, bytes));
    },
    has: (hash) => Promise.resolve(held.has(hash)),
    delete: (hash) => {
      held.delete(hash);
      return Promise.resolve();
    },
    /**
     * This store keeps no origin, so it answers the only safe way: everything it holds is
     * irreplaceable. A cache that wrongly says "you can drop this" loses bytes; one that wrongly
     * says "keep it" costs space, and only one of those is recoverable.
     */
    origin: (hash) => Promise.resolve(held.has(hash) ? "mine" : undefined),
    irreplaceable: () =>
      // SAFETY: the keys are the hashes `put`/`putAt` stored them under
      Promise.resolve([...held.keys()] as BlobHash[]),
  };
}

/**
 * Bytes in the database the rest of the mesh already uses — a relay's durable home, or a device
 * that wants its photos back after a restart. The table is the mesh's own, not the app's.
 */
export function sqlBlobStore(driver: SqlDriver): Promise<Result<BlobStore, BlobError>> {
  const { placeholder: p, name: dialect } = dialectOf(driver);
  const TABLE = logTable("blobs", placementOf(driver));
  const bytes = driver.dialect === "postgres" ? "BYTEA" : "BLOB";
  // a put is idempotent because the name is the content: the second one has nothing to change
  const insert =
    driver.dialect === "postgres"
      ? `INSERT INTO ${TABLE} (hash, bytes, origin) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING`
      : `INSERT OR IGNORE INTO ${TABLE} (hash, bytes, origin) VALUES (?, ?, ?)`;
  /**
   * A blob this device made, arriving again from a peer, stays `mine`.
   *
   * The insert above ignores the conflict, so the row keeps whatever origin it had — which is the
   * direction that matters. Demoting it to `cached` on an echo of our own bytes would license an
   * eviction of the only copy, and the peer that sent it may have got it from us.
   */
  const written = async (
    hash: BlobHash,
    raw: Uint8Array,
    origin: BlobOrigin,
  ): Promise<Result<void, BlobError>> => {
    const verified = verifyBlob(hash, raw);
    if (verified.isErr()) return Result.err<void, BlobError>(verified.error);
    const done = await attempt("blob put failed", () =>
      driver.run(insert, [String(hash), raw, origin]),
    );
    return done.mapError<BlobError>(
      (failure) => new BlobNotFound({ hash: String(hash), message: failure.message }),
    );
  };

  const store: BlobStore = {
    put: async (raw) => {
      const hash = hashOf(raw);
      return (await written(hash, raw, "mine")).map(() => hash);
    },
    putAt: (hash, raw) => written(hash, raw, "cached"),
    get: async (hash) => {
      const rows = await driver.all(`SELECT bytes FROM ${TABLE} WHERE hash = ${p(1)}`, [
        String(hash),
      ]);
      const cell = rows[0]?.[0];
      if (!(cell instanceof Uint8Array)) return missing(hash);
      return verifyBlob(hash, cell);
    },
    has: async (hash) =>
      (await driver.all(`SELECT 1 FROM ${TABLE} WHERE hash = ${p(1)}`, [String(hash)])).length > 0,
    delete: async (hash) => {
      await driver.run(`DELETE FROM ${TABLE} WHERE hash = ${p(1)}`, [String(hash)]);
    },
    origin: async (hash) => {
      const rows = await driver.all(`SELECT origin FROM ${TABLE} WHERE hash = ${p(1)}`, [
        String(hash),
      ]);
      // SAFETY: the column is written only by `written` above, from `BlobOrigin`
      return rows[0]?.[0] === undefined ? undefined : (String(rows[0][0]) as BlobOrigin);
    },
    irreplaceable: async () => {
      const rows = await driver.all(`SELECT hash FROM ${TABLE} WHERE origin = ${p(1)}`, ["mine"]);
      // SAFETY: the column is this store's own hash column, written from `BlobHash`
      return rows.map((row) => String(row[0]) as BlobHash);
    },
  };
  // the namespace first: this store is opened on its own by callers that never opened a log
  const ddl = [
    ...namespaceDdl(dialect),
    `CREATE TABLE IF NOT EXISTS ${TABLE} (hash TEXT PRIMARY KEY, bytes ${bytes} NOT NULL, origin TEXT NOT NULL)`,
  ];
  return (async () => {
    for (const sql of ddl) await driver.run(sql);
    return Result.ok<BlobStore, BlobError>(store);
  })();
}
