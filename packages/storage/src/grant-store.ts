import type { StoreFailure } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";

import { dialectOf } from "./dialect.js";
import { attempt } from "./sql.js";

/**
 * Where a device keeps the grants it has been told about, so a restart does not lose them.
 *
 * The registry itself is memory: it learns grants from the handshake, which is right for a
 * device that has just met someone and wrong for one that has merely rebooted. Without this,
 * every author quarantines on `NoGrant` until each peer re-sends — D08's own watch-out, reached
 * by restarting rather than by a dropped frame, and on a radio that meets nobody for an hour it
 * is an hour of refusing writes it could have admitted.
 *
 * Wires are stored, never parsed grants. What comes back out goes through `register` like
 * anything off the wire, so the issuer's signature is checked again and an expired grant simply
 * does not return — a store cannot launder a grant into something the registry would not accept.
 */
export interface GrantStore {
  /** Every wire held, for the registry to re-verify on the way back in. */
  readonly all: () => Promise<Result<readonly Uint8Array[], StoreFailure>>;
  /** Keyed by device, so a re-issued grant replaces the one it supersedes rather than joining it. */
  readonly put: (device: PeerId, wire: Uint8Array) => Promise<Result<void, StoreFailure>>;
  readonly delete: (device: PeerId) => Promise<Result<void, StoreFailure>>;
}

/** A store that lives as long as the process — what tests run against, and a mesh with no database. */
export function memoryGrantStore(): GrantStore {
  const held = new Map<string, Uint8Array>();
  const ok = <T>(value: T) => Promise.resolve(Result.ok<T, StoreFailure>(value));
  return {
    all: () => ok([...held.values()]),
    put: (device, wire) => ok(void held.set(String(device), Uint8Array.from(wire))),
    delete: (device) => ok(void held.delete(String(device))),
  };
}

/** The grants in the database the rest of the mesh already uses. The table is the mesh's own. */
export function sqlGrantStore(driver: SqlDriver): Promise<Result<GrantStore, StoreFailure>> {
  const { placeholder: p } = dialectOf(driver);
  const bytes = driver.dialect === "postgres" ? "BYTEA" : "BLOB";
  // keyed by device, so the upsert is how a re-issued grant supersedes the one before it
  const upsert =
    driver.dialect === "postgres"
      ? `INSERT INTO _syncmesh_grants (device, wire) VALUES ($1, $2)
         ON CONFLICT (device) DO UPDATE SET wire = EXCLUDED.wire`
      : `INSERT INTO _syncmesh_grants (device, wire) VALUES (?, ?)
         ON CONFLICT (device) DO UPDATE SET wire = excluded.wire`;
  const store: GrantStore = {
    all: async () => {
      const rows = await attempt("reading stored grants failed", () =>
        driver.all(`SELECT wire FROM _syncmesh_grants`),
      );
      return rows.map((found) =>
        found.map((row) => row[0]).filter((cell) => cell instanceof Uint8Array),
      );
    },
    put: async (device, wire) =>
      (
        await attempt("storing a grant failed", () => driver.run(upsert, [String(device), wire]))
      ).map(() => undefined),
    delete: async (device) =>
      (
        await attempt("forgetting a grant failed", () =>
          driver.run(`DELETE FROM _syncmesh_grants WHERE device = ${p(1)}`, [String(device)]),
        )
      ).map(() => undefined),
  };
  return driver
    .run(
      `CREATE TABLE IF NOT EXISTS _syncmesh_grants (device TEXT PRIMARY KEY, wire ${bytes} NOT NULL)`,
    )
    .then(() => Result.ok<GrantStore, StoreFailure>(store));
}
