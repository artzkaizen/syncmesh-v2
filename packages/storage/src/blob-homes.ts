import type { StoreFailure } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { BlobHash } from "./blob.js";
import type { SqlDriver } from "./driver.js";

import { driverDialect, logTable, namespaceDdl, logPlacement } from "./dialect.js";
import { attempt } from "./sql.js";

/**
 * Where a relay's blob may be read (D44): every partition a put of its bytes was billed to.
 * `undefined` is a put that named no partition — readable by every socket in the room, as an
 * unpinned row is.
 */
export type BlobHome = PartitionKey | undefined;

/**
 * The partitions each kept blob was put into, which is what a grant-gated room checks a fetch
 * against. A home is added only by a put, and a put carries the bytes and is verified against the
 * hash before anything is recorded: naming a hash is not enough to claim it, holding the bytes is.
 *
 * Kept beside the bytes, so it survives the room closing; a store that forgets it on restart would
 * answer an entitled reader `blob-missing` until somebody put the bytes again.
 */
export interface BlobHomes {
  /** Records that a verified put billed these bytes to `home`. Idempotent. */
  readonly add: (hash: BlobHash, home: BlobHome) => Promise<Result<void, StoreFailure>>;
  /** Every partition these bytes were put into; empty for bytes no put of this room recorded. */
  readonly of: (hash: BlobHash) => Promise<Result<readonly BlobHome[], StoreFailure>>;
  /** The bytes left the room: forget where they could be read. */
  readonly forget: (hash: BlobHash) => Promise<Result<void, StoreFailure>>;
}

/** Homes for the life of this process: what a room with no durable store keeps. */
export function memoryBlobHomes(): BlobHomes {
  const homes = new Map<BlobHash, Set<BlobHome>>();
  const ok = <T>(value: T) => Promise.resolve(Result.ok<T, StoreFailure>(value));
  return {
    add: (hash, home) => {
      const held = homes.get(hash) ?? new Set<BlobHome>();
      held.add(home);
      homes.set(hash, held);
      return ok(undefined);
    },
    of: (hash) => ok([...(homes.get(hash) ?? [])]),
    forget: (hash) => ok(void homes.delete(hash)),
  };
}

/**
 * The column's spelling of "no partition". A partition key is `kind:id`, never empty, so the
 * empty string cannot collide with one, and a NOT NULL column keeps the primary key one row per
 * pair in both dialects.
 */
const UNPINNED = "";

/**
 * Homes in the same database as the room's blobs, so a room reopened over kept bytes still knows
 * who may read them.
 *
 * @example
 * ```ts
 * const homes = (await sqlBlobHomes(driver)).unwrap();
 * await homes.add(hash, partition);
 * ```
 */
export async function sqlBlobHomes(driver: SqlDriver): Promise<Result<BlobHomes, StoreFailure>> {
  const { placeholder: p, name: dialect } = driverDialect(driver);
  const TABLE = logTable("blob_homes", logPlacement(driver));
  const insert =
    driver.dialect === "postgres"
      ? `INSERT INTO ${TABLE} (hash, home) VALUES ($1, $2) ON CONFLICT (hash, home) DO NOTHING`
      : `INSERT OR IGNORE INTO ${TABLE} (hash, home) VALUES (?, ?)`;
  const homes: BlobHomes = {
    add: (hash, home) =>
      attempt("blob home add failed", () => driver.run(insert, [hash, home ?? UNPINNED])),
    of: (hash) =>
      attempt("blob home read failed", () =>
        driver.all(`SELECT home FROM ${TABLE} WHERE hash = ${p(1)}`, [hash]),
      ).then((rows) =>
        rows.map((found) =>
          found.map(([home]) =>
            // SAFETY: the column is written only by `add` above, from a PartitionKey or UNPINNED
            home === UNPINNED ? undefined : (String(home) as PartitionKey),
          ),
        ),
      ),
    forget: (hash) =>
      attempt("blob home forget failed", () =>
        driver.run(`DELETE FROM ${TABLE} WHERE hash = ${p(1)}`, [hash]),
      ),
  };
  const ddl = [
    ...namespaceDdl(dialect),
    `CREATE TABLE IF NOT EXISTS ${TABLE} (hash TEXT NOT NULL, home TEXT NOT NULL, PRIMARY KEY (hash, home))`,
  ];
  return attempt("blob homes open failed", async () => {
    for (const sql of ddl) await driver.run(sql);
    return homes;
  });
}
