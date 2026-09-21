/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- one file, one job: regrouping a set of options into the flat names the constructor underneath still declares. The mapping tables are checked against the group types by `satisfies`, so the keys are not free-form; what is unavoidably dictionary-shaped is the copying itself, and keeping it here is what stops it being spread across every call site */

import type { MeshOptions, MeshShaping } from "@syncmesh/client";
import type { EventStore, StateStore } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { ColumnsMap, PartitionTree, PresenceMap, Roles, Schema } from "@syncmesh/schema";
import type { BlobStore, SqlDriver, Stores } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Entropy, Identity } from "@syncmesh/wire";

import { deviceIdentity } from "@syncmesh/client";
import { panic } from "@syncmesh/result";
import { useEntropy } from "@syncmesh/wire";

import type { AuthorityLink, Router } from "./api.js";

/**
 * What a client is constructed from — **grouped by the decision, not flattened into a bag.**
 *
 * The shape this replaced was twenty-one top-level fields in which `issuerKey` sat beside
 * `dataDir` beside `rls`, and a reader had no way to tell which three of them were one decision.
 * They are four: where the data lives, who is trusted, what the radios are, and who is calling.
 *
 * **No tenant, workspace or shop appears here.** Scope is input, never construction (book ch. 3);
 * a client is built once and every call says which replica it is about.
 */
export interface ClientOptions<
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
> {
  readonly schema: Schema<P, RS, C, PC>;
  /** The app's own API — every read and every write it performs. */
  readonly procedures: R;
  /**
   * Where this node's data lives: {@link sqlite}, or {@link postgres} for a node that materializes
   * into a database somebody else also reads. The platform's own SQLite when unasked.
   */
  readonly storage?: Storage;
  /**
   * Shipped config, identical on every peer: who signs grants, and whose writes may correct.
   *
   * Grouped because the five were always one decision and never read as one. **Never
   * runtime-derived** — a peer whose verdict depended on which keys it happened to carry would
   * disagree with its own mesh forever.
   */
  readonly trust?: Trust;
  /** Who is calling, and how to prove it (book ch. 14). */
  readonly auth?: MeshOptions<P, RS, C, "sqlite", PC>["auth"];
  /** Started at construction; `$transports.add/remove` reshape the set later. */
  readonly transports?: MeshOptions<P, RS, C, "sqlite", PC>["transports"];
  /**
   * The platform signals that mean *look at your links again* — an app returning to the
   * foreground, a network becoming reachable (`@syncmesh/react-native` ships both).
   *
   * Recovery belongs here rather than in an app: named once, the mesh subscribes for as long as it
   * runs and tells every medium to re-check its link when one of them fires. Absent — every server,
   * and any device where nothing sleeps — nothing subscribes and nothing changes.
   */
  readonly knocks?: MeshOptions<P, RS, C, "sqlite", PC>["knocks"];
  /** Fleet shaping: periodic re-peering, and what belongs to the room rather than a medium. */
  readonly mesh?: MeshShaping;
  /**
   * An **override only**. By default admission is derived from grants — an overlapping grant, or
   * a peer asking for one, else deny. This is for the rule a deployment adds on top ("no BLE on
   * site"), never the rule that makes the default work.
   */
  readonly admission?: MeshOptions<P, RS, C, "sqlite", PC>["onGrantRequest"];
  /**
   * A signed checkpoint to offer with any state this node serves (RFC-0019, book ch. 4).
   *
   * What makes a join cheap. Without one, a device arriving empty has to replay the log and check
   * a signature per event; with one, it installs the rows and checks a single certificate over the
   * hash of what it installed. Only a holder of the issuer key can mint one — `issueCheckpoint` —
   * but any node may forward the one it was given.
   */
  readonly certificate?: MeshOptions<P, RS, C, "sqlite", PC>["certificate"];
  /**
   * The engine's CSPRNG, for the one moment it is needed before any key exists: device keys and
   * handshake nonces. Defaults to `globalThis.crypto.getRandomValues`; pass `expo-crypto`'s on
   * React Native, where there is no global one.
   */
  readonly entropy?: Entropy;
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
  /** Carries `authority` calls. Absent, one fails naming itself rather than pretending. */
  readonly link?: AuthorityLink;
  /** Everything the engine reports, from before there is a client to report it on. */
  readonly onError?: MeshOptions<P, RS, C, "sqlite", PC>["onError"];
  readonly now?: () => Temporal.Instant;
  readonly undoDepth?: number;
}

/** Who this mesh trusts, and the private halves only the peer that *is* one of them holds. */
export interface Trust {
  /** The peer whose signature grants must carry; absent, the mesh runs ungranted. */
  readonly issuer?: PeerId;
  /** The peer whose events may write `global` tables — shipped in config like the issuer's. */
  readonly authority?: PeerId;
  /** The issuer's private half. Only the org's root of trust holds this; it unlocks `$grants.issue`. */
  readonly issuerKey?: Identity;
  /** The account's private half. Only a device vouching for itself holds this. */
  readonly accountKey?: Identity;
  /** Read `_links` where no grant is held, so `owner()` answers across a person's devices (D21). */
  readonly accounts?: boolean;
}

/**
 * Where a device's data lives, as one answer instead of seven fields.
 *
 * `dir` alone is the ordinary case: the platform opens its own SQLite there — OPFS-backed WASM in
 * a browser, a file under Bun and Node. Everything else on this type is an escape hatch for a
 * caller who has already opened something, and each stays **theirs to close**, which is the
 * property that makes one database per tenant possible (D07).
 */
export interface SqliteStorage {
  readonly dialect: "sqlite";
  /** Where the default store's file goes. Default `.syncmesh`. */
  readonly dir?: string;
  /** Your own connection: tables and capture are installed on it and it becomes the log too. */
  readonly driver?: SqlDriver;
  /** Stores someone else opened — what `scopedStores().storeFor(scope)` hands back (D07). */
  readonly stores?: Stores;
  /** The event log alone: a mesh with no SQL tables. Memory is never a default — ask for it. */
  readonly store?: EventStore;
  readonly stateStore?: StateStore;
  /** Where fetched bytes are cached (D18); absent, an in-memory cache for the process. */
  readonly blobs?: BlobStore;
}

/**
 * SQLite on this device, wherever this device keeps it.
 *
 * @example
 * const client = createClient({ schema, procedures, identity, storage: sqlite() });
 */
export const sqlite = (options: Omit<SqliteStorage, "dialect"> = {}): SqliteStorage => ({
  dialect: "sqlite",
  ...options,
});

/**
 * Postgres, for the node whose folded rows are somebody else's tables too.
 *
 * The same store as {@link sqlite} in every way that matters to the engine — a log, the rows it
 * folds to, and the capture that turns a write into an event — and the difference is who else is
 * reading. A device's SQLite is its own; a server's Postgres is the one an existing backend
 * already queries, which is why this exists at all: the fold materializes *into your schema*,
 * and a `SELECT` from a report, a cron job or another service sees what the mesh agreed on
 * without asking the mesh anything (book ch. 18).
 *
 * **The driver is the dialect.** Nothing here declares Postgres a second time — `postgresDriver`
 * from `@syncmesh/postgres` carries `dialect: "postgres"` and every layer below reads it off the
 * connection, so a mismatch between what a caller asked for and what they handed over is not
 * representable.
 *
 * @example
 * import { postgres } from "@syncmesh/orpc";
 * import { postgresDriver } from "@syncmesh/postgres";
 *
 * const server = await createServer({
 *   schema,
 *   procedures,
 *   handlers,
 *   storage: postgres({ driver: postgresDriver(sql), rls: true }),
 * });
 */
export interface PostgresStorage {
  readonly dialect: "postgres";
  /** The connection this node folds into — yours to open, and yours to close. */
  readonly driver: SqlDriver & { readonly dialect: "postgres" };
  /**
   * Compile the schema's `read` rules into the database's own row-level policies.
   *
   * Belt and braces rather than the enforcement itself: every receiver already checks `allow` at
   * the fold, and this puts the same rules where a hand-written `SELECT` on the same connection
   * cannot get around them. Postgres only, which is why it lives on this storage and not the
   * other one.
   */
  readonly rls?: boolean;
  /** Where fetched bytes are cached (D18); absent, an in-memory cache for the process. */
  readonly blobs?: BlobStore;
}

/** Where a node's data lives — one of the two answers, told apart by the connection it names. */
export type Storage = SqliteStorage | PostgresStorage;

/**
 * Postgres on a connection you opened.
 *
 * @example
 * const server = await createServer({ …, storage: postgres({ driver: postgresDriver(sql) }) });
 */
export const postgres = (options: Omit<PostgresStorage, "dialect">): PostgresStorage => ({
  dialect: "postgres",
  ...options,
});

/**
 * The grouped options, as the flat bag `createMesh` still takes underneath.
 *
 * One translation in one place, and the reason it is worth having rather than passing the bag
 * straight through: the groups are the API and the bag is an implementation detail on the book's
 * cut list. When `createMesh` goes, this function is what disappears — not every call site.
 *
 * Keys are assigned rather than spread because `exactOptionalPropertyTypes` reads an explicit
 * `undefined` as a value, and "no issuer" is the absence of the key, not the presence of nothing.
 */
/** Each group's own keys, flattened under the names the bag underneath still uses. */
const TRUST_KEYS = {
  issuer: "issuer",
  authority: "authority",
  issuerKey: "issuerKey",
  accountKey: "accountKey",
  accounts: "accounts",
} satisfies Record<keyof Trust, string>;

const STORAGE_KEYS = {
  dir: "dataDir",
  driver: "driver",
  stores: "stores",
  store: "store",
  stateStore: "stateStore",
  blobs: "blobStore",
} satisfies Record<Exclude<keyof SqliteStorage, "dialect">, string>;

const POSTGRES_KEYS = {
  driver: "driver",
  rls: "rls",
  blobs: "blobStore",
} satisfies Record<Exclude<keyof PostgresStorage, "dialect">, string>;

/** Copies the keys a group actually carries; an absent one stays absent, never `undefined`. */
const spread = (
  into: Record<string, unknown>,
  group: object | undefined,
  names: Record<string, string>,
): void => {
  for (const [from, to] of Object.entries(names)) {
    const value = (group as Record<string, unknown> | undefined)?.[from];
    if (value !== undefined) into[to] = value;
  }
};

/**
 * The grouped options, as the flat bag `createMesh` still takes underneath.
 *
 * One translation in one place, and that is the point rather than an inconvenience: the groups
 * are the API and the bag is an implementation detail on the book's cut list. When `createMesh`
 * goes, this function is what disappears — not every call site in every app.
 *
 * Keys are assigned rather than spread because `exactOptionalPropertyTypes` reads an explicit
 * `undefined` as a value, and "no issuer" is the absence of the key, not the presence of nothing.
 */
export const flatten = <
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
>(
  options: ClientOptions<R, P, RS, C, PC>,
): AppOptions<R, P, RS, C, PC> => {
  const { storage, trust, admission, entropy, ...rest } = options;
  // SAFETY: a `ClientOptions` is a plain record of its own declared keys
  const ungrouped = rest as Record<string, unknown>;
  // before anything else: the first key this client mints must come from the source the app named
  if (entropy !== undefined) useEntropy(entropy);
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ungrouped)) if (value !== undefined) flat[key] = value;
  spread(flat, trust, TRUST_KEYS);
  // the storage group names its own keys: a dialect is a different set of answers, not a flag
  spread(flat, storage, storage?.dialect === "postgres" ? POSTGRES_KEYS : STORAGE_KEYS);
  if (admission !== undefined) flat["onGrantRequest"] = admission;
  // SAFETY: every key written above is one of `AppOptions`' own, under the name it declares —
  // `TRUST_KEYS` and `STORAGE_KEYS` are checked against the group types by `satisfies`, and the
  // ungrouped rest is copied through unchanged. Nothing is widened and nothing is invented.
  return flat as unknown as AppOptions<R, P, RS, C, PC>;
};

/**
 * What {@link flatten} builds: the mesh's own options, plus the two the client keeps.
 *
 * Declared here rather than beside `createClient` because this is the shape the flattening
 * produces, and a type that describes one function's output belongs with that function.
 */
export interface AppOptions<
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
> extends MeshOptions<P, RS, C, "sqlite", PC> {
  readonly procedures: R;
  readonly link?: AuthorityLink;
}

/**
 * The options with this device's identity settled — read from its own database, or minted there.
 *
 * Resolved here rather than inside `createMesh` because the identity is an *input* to opening a
 * mesh: the default store is one file per peer id, so there is no mesh to ask before the answer
 * exists. The driver a caller names is asked directly, which is also the only place the key can
 * honestly live — beside the log it signs, gone when that is gone.
 */
export const named = async <
  R extends Router,
  P extends PartitionTree,
  RS extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap,
>(
  options: ClientOptions<R, P, RS, C, PC>,
): Promise<ClientOptions<R, P, RS, C, PC> & { readonly identity: Identity }> => {
  if (options.identity !== undefined) return { ...options, identity: options.identity };
  const storage = options.storage;
  const driver =
    storage?.driver ?? (storage?.dialect === "postgres" ? undefined : storage?.stores?.driver);
  if (driver === undefined)
    panic(
      "no identity and nowhere to keep one: pass `storage: sqlite({ driver })` so the device key can live beside the log it signs, or pass `identity` from your own key store",
    );
  const minted = await deviceIdentity(driver);
  if (minted.isErr()) panic(minted.error.message, minted.error);
  return { ...options, identity: minted.value };
};
