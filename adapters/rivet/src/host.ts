import type { TelemetryListener } from "@syncmesh/engine";
import type {
  RelayHost,
  RelayLimits,
  RelayPosture,
  RelayRetention,
  RoomStore,
  SocketSession,
} from "@syncmesh/relay";
import type { SeedVault } from "@syncmesh/wire";

import {
  createRelayHost,
  describeRoom,
  openDurableBlobs,
  relayEpoch,
  relayIdentity,
} from "@syncmesh/relay";
import { omitUndefined, panic } from "@syncmesh/result";
import { sqliteEventStore } from "@syncmesh/storage";

import type { RivetDatabase } from "./driver.js";
import type { RivetWebSocket } from "./socket.js";

import { rivetSqlDriver } from "./driver.js";
import { OPEN, bytesIn, closeReason, rivetRelaySocket } from "./socket.js";

/**
 * The slice of a Rivet actor's context the room reads: which actor this is, its database, the
 * upgrade request when the runtime hands one over, and the signal that fires when the instance
 * goes to sleep or is destroyed.
 */
export interface RivetRelayContext {
  readonly actorId: string;
  /** The actor's key; joined with `/` it is the room's name, which is what a posture is asked about. */
  readonly key: readonly string[];
  readonly db: RivetDatabase;
  /** Absent when the runtime gives none; a posture then refuses the socket outright. */
  readonly request?: Request;
  readonly abortSignal: AbortSignal;
}

export interface RelayRivetActorOptions {
  readonly keepaliveMs?: number;
  readonly pageSize?: number;
  readonly maxBacklog?: number;
  readonly versions?: readonly number[];
  readonly limits?: Partial<RelayLimits>;
  readonly retention?: RelayRetention;
  /** Who may open a socket onto this actor: origins, announce, and `verifyJoin` with the request in hand. */
  readonly posture?: RelayPosture;
  readonly onTelemetry?: TelemetryListener;
  /** Serve blobs from the actor's own database (D18). Default true. */
  readonly blobs?: boolean;
  /**
   * What seals the room's signing seed in the actor's database (N26). Required: `createKeyVault`
   * over a key the deployment provides, `createSecretStoreVault` over a keychain, or
   * `createPlaintextVault()` for tests and development, which every open says.
   */
  readonly vault?: SeedVault;
  /** Where the plaintext vault's notice and a migration's report go. Default `console.warn`. */
  readonly onNotice?: (message: string) => void;
}

/** The two raw hooks of a Rivet actor definition, already wired to a room. */
export interface RelayRivetActor {
  /**
   * `onWebSocket`: the posture and capacity caps first, then the room. A socket that arrives
   * without its upgrade request is refused when a posture is set, since there is nothing to check.
   */
  readonly onWebSocket: (c: RivetRelayContext, ws: RivetWebSocket) => Promise<void>;
  /** `onRequest`: a plain `GET` describes the room; nothing here upgrades. */
  readonly onRequest: (c: RivetRelayContext, request: Request) => Promise<Response>;
}

/** WebSocket close code for a refusal the posture made: policy violation. */
const POLICY_VIOLATION = 1008;

/** WebSocket close code for a capacity cap: try again later, since the seat may be free by then. */
const TRY_AGAIN_LATER = 1013;

/** WebSocket close code for a room that could not open: the server hit an unexpected condition. */
const INTERNAL_ERROR = 1011;

/** The room's name, from the actor's key: the platform has already routed this socket to the actor that *is* the room. */
const roomName = (key: readonly string[]): string => (key.length === 0 ? "main" : key.join("/"));

/**
 * D09-C on Rivet: the room mounted in one actor, keyed by room name, so the platform routes every
 * socket for a room to the same instance — which is what removes the fleet problem, and why there
 * is no `fanout` option here (E25's watch-out).
 *
 * The room's log, epoch and key live in the actor's own SQLite, so an actor that sleeps and wakes,
 * or moves, is the same room under the same name a client pins (D36). Its sockets are the raw
 * `onWebSocket` kind and **must not hibernate** — leave `canHibernateWebSocket` at its default
 * `false`: a hibernated socket would wake into an instance with no link state for it. A socket the
 * actor drops on sleep is redialled by the client, which resumes from its cursors.
 *
 * The room signs no custody (D28, U38), and there is no option for it: its key lives beside the
 * log in the actor's SQLite, so a lost log takes the key with it and what the old key signed would
 * never be withdrawn. Its acks still answer `synced()`; detach waits for a device's receipt.
 *
 * @example
 * const relay = relayRivetActor({ posture, vault: createKeyVault(hexToBytes(process.env.RELAY_SEAL_KEY).unwrap()) });
 * export const room = actor({
 *   db: db(),
 *   onWebSocket: (c, ws) => relay.onWebSocket(c, ws),
 *   onRequest: (c, request) => relay.onRequest(c, request),
 * });
 */
export function relayRivetActor(options: RelayRivetActorOptions = {}): RelayRivetActor {
  const { vault } = options;
  if (vault === undefined)
    panic(
      "a Rivet relay actor keeps its room key at rest: pass `vault` — createKeyVault over a key the deployment provides, or createPlaintextVault() for tests and development (N26)",
    );
  const secrets = omitUndefined({ vault, onNotice: options.onNotice });
  /** One host per live instance; the hooks are shared by every instance the process runs. */
  const hosts = new Map<string, Promise<RelayHost>>();

  /**
   * The host for this instance, opened over the key kept in the actor's database: one actor is
   * one room, so the room's key is the host's, and the key a `GET` describes is the key the
   * hello signs with — across every sleep.
   */
  const open = async (c: RivetRelayContext): Promise<RelayHost> => {
    const driver = rivetSqlDriver(c.db);
    const identity = await relayIdentity(driver, secrets);
    const openRoomStore = async (): Promise<RoomStore> => {
      const store = (await sqliteEventStore(driver)).match({
        ok: (value) => value,
        err: (failure) => panic(`the room's log failed to open: ${failure.message}`),
      });
      const blobs = options.blobs === false ? {} : await openDurableBlobs(driver);
      return {
        store,
        epoch: await relayEpoch(driver),
        // the platform's own database, which outlives every eviction (D42)
        durable: true,
        ...blobs,
        // the actor's storage is the platform's to close; nothing was borrowed
        release: () => undefined,
      };
    };
    const host = createRelayHost(
      omitUndefined({
        openRoomStore,
        identity,
        keepaliveMs: options.keepaliveMs,
        pageSize: options.pageSize,
        maxBacklog: options.maxBacklog,
        versions: options.versions,
        limits: options.limits,
        retention: options.retention,
        posture: options.posture,
        onTelemetry: options.onTelemetry,
      }),
    );
    return host;
  };

  /**
   * Why a socket is turned away, or `undefined` to admit it. The posture is enforced only at the
   * upgrade, so a socket the runtime hands over without its request cannot be checked against
   * one and is refused whenever a posture is set; the capacity caps need no request and always run.
   */
  const admit = async (
    host: RelayHost,
    request: Request | undefined,
    name: string,
  ): Promise<{ readonly code: number; readonly reason: string } | undefined> => {
    if (request !== undefined) {
      const refused = await host.gate(request, name);
      if (refused === undefined) return undefined;
      // the gate's 503 is a full room or host, which a later dial may find free
      const code = refused.status === 503 ? TRY_AGAIN_LATER : POLICY_VIOLATION;
      return { code, reason: closeReason(await refused.text()) };
    }
    if (options.posture !== undefined)
      return { code: POLICY_VIOLATION, reason: "syncmesh relay: no upgrade request to check" };
    if (host.atCapacity(name))
      return { code: TRY_AGAIN_LATER, reason: "syncmesh relay: at capacity, retry shortly" };
    return undefined;
  };

  const ensureHost = (c: RivetRelayContext): Promise<RelayHost> => {
    const known = hosts.get(c.actorId);
    if (known !== undefined) return known;
    const held = open(c);
    hosts.set(c.actorId, held);
    const forget = (): void => {
      if (hosts.get(c.actorId) === held) hosts.delete(c.actorId);
    };
    // a room that failed to open is not cached: the next socket tries again
    void held.catch(forget);
    // asleep or destroyed, the instance's memory goes; its room is reopened from SQLite on wake.
    // Taken from before the open is awaited, so an instance that sleeps mid-open still closes it
    const retire = (): void => {
      forget();
      void held.then(
        (host) => host.close(),
        () => undefined,
      );
    };
    if (c.abortSignal.aborted) retire();
    else c.abortSignal.addEventListener("abort", retire, { once: true });
    return held;
  };

  return {
    onWebSocket: async (c, ws) => {
      // listened for before anything is awaited: a socket that closes while its room opens or
      // its posture is asked must never be accepted, or its seat is held until the actor sleeps
      let session: SocketSession | undefined;
      let gone = false;
      ws.addEventListener("close", () => {
        gone = true;
        session?.closed();
      });
      // a room that cannot open still answers its socket, then lets the runtime see the failure
      const host = await ensureHost(c).catch((cause: unknown) => {
        ws.close(INTERNAL_ERROR, "syncmesh relay: the room failed to open");
        throw cause;
      });
      const name = roomName(c.key);
      const refused = await admit(host, c.request, name);
      if (gone || ws.readyState !== OPEN) return;
      if (refused !== undefined) {
        ws.close(refused.code, refused.reason);
        return;
      }
      ws.binaryType = "arraybuffer";
      const accepted = host.accept(rivetRelaySocket(ws), name);
      session = accepted;
      ws.addEventListener("message", (event) => {
        const bytes = bytesIn(event.data);
        if (bytes !== undefined) accepted.receive(bytes);
      });
    },
    // described under the actor's own name: Rivet's path is `/actors/<name>/http/…`, which is
    // routing, not a room
    onRequest: async (c, request) =>
      describeRoom(
        await ensureHost(c),
        new Request(new URL(`/${roomName(c.key)}`, request.url).href, {
          method: request.method,
          headers: request.headers,
        }),
      ),
  };
}
