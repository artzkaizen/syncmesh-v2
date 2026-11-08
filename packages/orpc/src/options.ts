import type { MeshOptions, SeedVault } from "@syncmesh/client";
import type { ColumnsMap, PresenceMap } from "@syncmesh/schema";
import type { SqlDialect } from "@syncmesh/storage";
import type { WindowClient } from "@syncmesh/window";
import type { Identity } from "@syncmesh/wire";

import { deviceIdentity } from "@syncmesh/client";
import { panic } from "@syncmesh/result";
import { supplyEntropy } from "@syncmesh/wire";

import type { AuthorityLink, Router } from "./api.js";

/**
 * What a client is constructed from: the mesh's own grouped options ({@link MeshOptions} —
 * `storage`, `trust`, `transports`, `auth` and the rest), with the device key optional and the
 * app's procedures beside them.
 *
 * Grouped by the decision, not flattened into a bag: `issuerKey` does not sit beside `dataDir`
 * beside `rls`, because they are three decisions and the groups say which. The mesh underneath
 * reads the same groups, so there is no translation between what an app writes here and what
 * opens.
 *
 * **No tenant, workspace or shop appears here.** Scope is input, never construction (book ch. 3);
 * a client is built once and every call says which replica it is about.
 *
 * @example
 * const client = createClient({
 *   schema,
 *   procedures: router,
 *   storage: sqlite({ dir: ".rounds" }),
 *   trust: { issuer, authority },
 *   transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
 * });
 */
export interface ClientOptions<
  R extends Router,
  C extends ColumnsMap,
  PC extends PresenceMap,
> extends Omit<MeshOptions<C, SqlDialect, PC>, "identity"> {
  /**
   * The app's own API — every read and every write it performs. Optional: a device that only
   * holds and carries the mesh (a relay, a courier, the embedded example's phone) has none, and
   * its client is the `$` surface alone.
   */
  readonly procedures?: R;
  /**
   * This device's signing key — **optional, because minting and keeping it is the library's job**
   * (book ch. 8).
   *
   * Absent, it is read from the database `storage` names, or minted into it on the first run
   * ({@link deviceIdentity}). Pass one only where the key comes from somewhere this cannot reach:
   * a platform keychain, a test fixture that needs two devices to be a known pair, or a server
   * whose identity is config every other peer already trusts.
   *
   * A build that ships a fixed one makes every install of it the same author, which is the
   * silent corruption a log cannot report — two profiles writing under one name, allocating
   * `(author, seq)` from two sequences, the loser's writes dropped as stale rather than refused.
   */
  readonly identity?: Identity;
  /**
   * Where the minted device key is sealed at rest when `identity` is absent (gaps U4; see
   * `deviceIdentity`). Default: WebCrypto in a browser, and a refused open elsewhere until one is
   * passed — `createSecureStoreVault()` from `@syncmesh/react-native/keystore` on a phone,
   * `createSecretStoreVault` over an OS keychain, or `createPlaintextVault()` for tests and
   * development.
   */
  readonly vault?: SeedVault;
  /** Carries `authority` calls. Absent, one fails naming itself rather than pretending. */
  readonly link?: AuthorityLink;
  /**
   * Carries the reads of `sync: "window"` tables, which the server serves a page at a time
   * (D43): `createWindowClient()`, attached to the socket the server's `serveWindows` answers on.
   * Absent, such a read fails naming itself rather than showing an empty table.
   */
  readonly windows?: WindowClient;
}

/**
 * The options with this device's identity settled — read from its own database, or minted there.
 *
 * Resolved here rather than inside the mesh's open because the identity is an *input* to opening a
 * mesh: the default store is one file per peer id, so there is no mesh to ask before the answer
 * exists. The driver a caller names is asked directly, which is also the only place the key can
 * honestly live — beside the log it signs, gone when that is gone.
 */
export const named = async <R extends Router, C extends ColumnsMap, PC extends PresenceMap>(
  options: ClientOptions<R, C, PC>,
): Promise<ClientOptions<R, C, PC> & { readonly identity: Identity }> => {
  if (options.identity !== undefined) return { ...options, identity: options.identity };
  // the key minted below is the first this client makes: it comes from the source the app named
  if (options.entropy !== undefined) supplyEntropy(options.entropy);
  const storage = options.storage;
  const driver =
    storage?.driver ?? (storage?.dialect === "postgres" ? undefined : storage?.stores?.driver);
  if (driver === undefined)
    panic(
      "no identity and nowhere to keep one: pass `storage: sqlite({ driver })` so the device key can live beside the log it signs, or pass `identity` from your own key store",
    );
  const minted = await deviceIdentity(
    driver,
    options.vault === undefined ? {} : { vault: options.vault },
  );
  if (minted.isErr()) panic(minted.error.message, minted.error);
  return { ...options, identity: minted.value };
};
