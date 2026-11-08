import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";
import type { SqlDialect } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";

import { omitUndefined, panic } from "@syncmesh/result";

import type { BootOptions } from "./boot.js";
import type { MeshOptions, Storage, Trust } from "./options.js";

/**
 * `storage` as its two answers: the device's SQLite (a directory, a bare log, a store set and its
 * sweep), or a database somebody else also reads (row-level security). One is always absent.
 */
export const splitStorage = (storage: Storage | undefined) => ({
  local: storage?.dialect === "sqlite" ? storage : undefined,
  served: storage?.dialect === "postgres" ? storage : undefined,
});

/**
 * Panics on a `trust` whose private halves do not belong to it: an issuer key for some other
 * issuer, or an account key where links are not read. Both are configuration, wrong at open.
 */
export function checkTrust(trust: Trust): void {
  if (trust.issuerKey !== undefined && trust.issuerKey.peerId !== trust.issuer)
    panic(
      "trust.issuerKey does not match trust.issuer: the private half must belong to the configured root of trust",
    );
  // the same shape one table over: a key whose feature is off signs rows this peer will never
  // read, and a mesh half-configured that way looks like one where links simply do not work
  if (trust.accountKey !== undefined && trust.accounts !== true)
    panic(
      "trust.accountKey does not match trust.accounts: links are only read where `trust.accounts: true` is set",
    );
}

/** The grouped options, read into what boot takes: the one place a group meets the engine's names. */
export function bootSettings<C extends ColumnsMap, D extends SqlDialect, PC extends PresenceMap>(
  options: MeshOptions<C, D, PC>,
  opened: Pick<BootOptions, "grantFor"> & { readonly now: () => Temporal.Instant },
): BootOptions {
  const { storage, trust = {} } = options;
  const { local, served } = splitStorage(storage);
  return {
    schema: options.schema,
    identity: options.identity,
    dataDir: local?.dir ?? ".syncmesh",
    now: opened.now,
    grantFor: opened.grantFor,
    ...omitUndefined({
      issuer: trust.issuer,
      authority: trust.authority,
      accounts: trust.accounts,
      driver: storage?.driver,
      stores: local?.stores,
      store: local?.store,
      stateStore: local?.stateStore,
      rls: served?.rls,
      strict: storage?.strict,
      undoDepth: options.undoDepth,
      clockDrift: options.clockDrift,
      onError: options.onError,
    }),
  };
}
