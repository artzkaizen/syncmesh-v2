import type { EventStore } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { BlobStore, SqlDriver, Stores } from "@syncmesh/storage";
import type { Identity } from "@syncmesh/wire";

import { omitUndefined, panic } from "@syncmesh/result";
import { sqlBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { bytesToHex, createIdentity, hexToBytes, randomBytes } from "@syncmesh/wire";

import type { GrantCache } from "./grant-cache.js";
import type { RelayPosture } from "./posture.js";
import type { RelayConnection, RelayRoomOptions } from "./room.js";
import type { HeldRoom, OpenedRoom } from "./rooms.js";
import type { RelaySocket } from "./sender.js";

import { DEFAULT_LIMITS } from "./limits.js";
import { createRoomAccess } from "./posture.js";
import { openRelayRoom } from "./room.js";
import { createRoomTable } from "./rooms.js";

/** What a host passes through to each room it opens; the room's own name and store are its business. */
export type RoomTuning = Partial<
  Pick<
    RelayRoomOptions,
    | "keepaliveMs"
    | "pageSize"
    | "maxBacklog"
    | "versions"
    | "identity"
    | "limits"
    | "retention"
    | "fanout"
    | "blobs"
    | "onTelemetry"
  >
>;

/** One room's durable log, however the host keeps it: a file, a DO's SQLite, memory. */
export interface RoomStore {
  readonly store: EventStore;
  readonly epoch: string;
  readonly blobs?: BlobStore;
  /**
   * The key kept beside this log, for a host where the room is its own process — a Durable
   * Object — and the name a client pins is the object's rather than a fleet's. Given, it signs
   * this room's hello in place of the host's key (D36).
   */
  readonly identity?: Identity;
  /** Gives back whatever opening took: file handles, and nothing for borrowed stores. */
  readonly release: () => Promise<void> | void;
}

export interface RelayHostOptions extends RoomTuning {
  /**
   * Opens one room's log. Called lazily per room, never upfront: a host serves only
   * the rooms somebody dials. A caller-supplied single log bypasses this entirely —
   * see `singleRoom`.
   */
  readonly openRoomStore: (name: string) => Promise<RoomStore>;
  /**
   * Your own log instead of per-room ones; the host then serves a single room
   * whatever the path says. The caller opened that store and the caller closes it.
   */
  readonly singleRoom?: { readonly store: EventStore; readonly epoch?: string };
  /** Who may open a socket, and onto which rooms: announce apart from access. */
  readonly posture?: RelayPosture;
  /**
   * How long a room with no socket on it is kept open before it is closed and its log handle
   * released. Absent, a room opened once is held for the life of the process. Its grant cache
   * outlives the eviction either way — see `createRoomTable` for why that one cannot be rebuilt.
   */
  readonly idleAfter?: Temporal.Duration;
}

/** One accepted socket: frames in, backpressure out, exactly one close. */
export interface SocketSession {
  readonly receive: (frame: Uint8Array) => void;
  readonly drain: () => void;
  readonly closed: () => void;
}

export interface RelayHost {
  /** The key every room here signs its link hello with (D36) — what a client pins with `relayKey`. */
  readonly peerId: PeerId;
  /** Everything that turns a request away before a socket exists, in refusal order. */
  readonly gate: (request: Request, room: string) => Promise<Response | undefined>;
  /** A caller-supplied store serves one room whatever the path says; otherwise the path is the room. */
  readonly roomFor: (path: string) => string;
  /**
   * Binds an accepted socket to its room. Returns at once; the room opens underneath
   * and frames that race it are flushed in order the moment the connection exists.
   * A socket closed while the room is still opening releases it on arrival instead
   * of holding it open for the life of the process.
   */
  readonly accept: (socket: RelaySocket, path: string) => SocketSession;
  /**
   * The room itself, for a host that binds its own connections — a hibernating one, which opens
   * a connection with the resume script it kept and cannot go through {@link accept}. Counted
   * like a socket: the room stays open until the hold is released.
   */
  readonly acquire: (path: string) => Promise<HeldRoom>;
  /** Live sockets across the whole host; the ceiling is enforced by the fetch layer. */
  readonly live: () => number;
  readonly atCapacity: () => boolean;
  readonly close: () => Promise<void>;
}

/** Everything that turns a request away before a socket exists, in refusal order. */
export const createGate = (
  access: ReturnType<typeof createRoomAccess>,
  atCapacity: () => boolean,
): ((request: Request, room: string) => Promise<Response | undefined>) => {
  return async (request: Request, room: string): Promise<Response | undefined> => {
    if (atCapacity())
      return new Response("syncmesh relay: at capacity, retry shortly", { status: 503 });
    if (!access.admitsOrigin(request.headers.get("origin")))
      return new Response("syncmesh relay: origin not allowed", { status: 403 });
    if (!access.announces(room))
      return new Response("syncmesh relay: no such room", { status: 404 });
    if (!(await access.admitsJoin(request, room)))
      return new Response("syncmesh relay: join refused", { status: 403 });
    return undefined;
  };
};

/** The relay's own facts beside the log: its lineage, and the key it signs with. */
const META_DDL = `CREATE TABLE IF NOT EXISTS "_relay_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`;

/** One `_relay_meta` value, or the one `mint` makes and writes when the key was never set. */
const metaOf = async (driver: SqlDriver, key: string, mint: () => string): Promise<string> => {
  await driver.run(META_DDL);
  const held = await driver.all(`SELECT "value" FROM "_relay_meta" WHERE "key" = ?`, [key]);
  const value = held[0]?.[0];
  if (value !== undefined && value !== null) return String(value); // the column is TEXT NOT NULL
  const fresh = mint();
  await driver.run(`INSERT INTO "_relay_meta" ("key", "value") VALUES (?, ?)`, [key, fresh]);
  return fresh;
};

/** The epoch rides in the log's own file: a new file is honestly a new lineage. */
export const epochOf = (driver: SqlDriver): Promise<string> =>
  metaOf(driver, "epoch", () => crypto.randomUUID());

/**
 * The key a room signs its link hello with (D36), kept beside the epoch so the room has one name
 * across restarts, evictions and moves — the name a client pins. Minted on the first open.
 */
export async function identityOf(driver: SqlDriver): Promise<Identity> {
  const seed = await metaOf(driver, "identity-seed", () => bytesToHex(randomBytes(32)));
  return hexToBytes(seed)
    .andThen((bytes) => createIdentity(bytes))
    .match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's stored key could not be read: ${failure.message}`),
    });
}

/**
 * A room's log over stores somebody opened on a SQLite file: the epoch persisted beside it, and
 * the room's own blob store on the same connection — never shared across rooms, because a room
 * that inherited another room's store would serve and keep another room's bytes under D18.
 *
 * What every file-backed mount opens per room; `defaultStore` from the platform's SQLite adapter
 * is what it is handed.
 */
export async function durableRoomStore(
  stores: Stores,
  options: { readonly blobs?: boolean } = {},
): Promise<RoomStore> {
  const { driver } = stores;
  let blobs: BlobStore | undefined;
  if (options.blobs !== false) {
    const opened = await sqlBlobStore(driver);
    if (opened.isOk()) blobs = opened.value;
  }
  return {
    store: stores.events,
    epoch: await epochOf(driver),
    ...omitUndefined({ blobs }),
    release: stores.close,
  };
}

/**
 * The relay with no runtime in it: room lifecycle, posture gate, socket binding and the
 * process-wide connection ceiling. A host supplies the log opener and the socket accepts —
 * Bun, Node and Durable Objects each mount this same core and differ only in those two.
 */
export function createRelayHost(options: RelayHostOptions): RelayHost {
  const access = createRoomAccess(options.posture);
  // one key for every room this process opens, so the relay has one name a client can pin (D36)
  const identity =
    options.identity ??
    createIdentity(randomBytes(32)).match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's identity could not be made: ${failure.message}`),
    });
  const roomOptions = omitUndefined({
    keepaliveMs: options.keepaliveMs,
    pageSize: options.pageSize,
    maxBacklog: options.maxBacklog,
    versions: options.versions,
    limits: options.limits,
    retention: options.retention,
    onTelemetry: options.onTelemetry,
    fanout: options.fanout,
    identity,
  });

  /**
   * A caller-supplied store has one lineage for as long as this process holds it. Minting inside
   * `open` gave every idle-room eviction a fresh epoch over an unchanged log, which is the one
   * thing an epoch is supposed to mean it is not.
   */
  const singleEpoch = options.singleRoom?.epoch ?? crypto.randomUUID();

  const open = async (name: string, grants: GrantCache): Promise<OpenedRoom> => {
    if (options.singleRoom !== undefined) {
      const room = await openRelayRoom({
        ...roomOptions,
        name,
        grants,
        store: options.singleRoom.store,
        epoch: singleEpoch,
      });
      // the caller opened that store and the caller closes it; an eviction here borrows nothing
      return room.match({
        ok: (value) => ({ room: value, release: () => undefined }),
        err: (failure) => panic(`the relay's store failed to open: ${failure.message}`),
      });
    }
    const held = await options.openRoomStore(name);
    const room = await openRelayRoom({
      ...roomOptions,
      ...omitUndefined({ blobs: held.blobs, identity: held.identity }),
      name,
      grants,
      store: held.store,
      epoch: held.epoch,
    });
    return room.match({
      ok: (value) => ({ room: value, release: held.release }),
      err: (failure) => panic(`the relay's store failed to open: ${failure.message}`),
    });
  };

  const table = createRoomTable({
    open,
    ...omitUndefined({ idleAfter: options.idleAfter }),
    now: () => Temporal.Now.instant(),
  });
  // a caller-supplied store is one log: it serves one room whatever the path says
  const roomFor = (path: string): string => (options.singleRoom === undefined ? path : "main");

  // the whole host's socket ceiling (gap audit №5); approximate under races, refused at fetch
  const cap = options.limits?.maxConnections ?? DEFAULT_LIMITS.maxConnections;
  let live = 0;
  const atCapacity = (): boolean => live >= cap;
  const gate = createGate(access, atCapacity);

  const accept = (socket: RelaySocket, path: string): SocketSession => {
    live += 1;
    let conn: RelayConnection | undefined;
    let pending: Uint8Array[] | undefined = [];
    let release: (() => void) | undefined;
    let gone = false;
    void table.acquire(roomFor(path)).then((held) => {
      if (gone) {
        // a socket closed while this was awaiting its room has already had its
        // `closed`, so nothing else will ever hand the room back and it would be
        // held open for the life of the process
        held.release();
        return;
      }
      release = held.release;
      conn = held.room.connect(socket);
      for (const frame of pending ?? []) conn.receive(frame);
      pending = undefined;
    });
    return {
      receive: (frame) => {
        if (conn === undefined) pending?.push(frame);
        else conn.receive(frame);
      },
      drain: () => {
        conn?.drain();
      },
      closed: () => {
        live -= 1;
        gone = true;
        conn?.closed();
        release?.();
      },
    };
  };

  return {
    peerId: identity.peerId,
    gate,
    roomFor,
    accept,
    acquire: (path) => table.acquire(roomFor(path)),
    live: () => live,
    atCapacity,
    close: () => table.close(),
  };
}
