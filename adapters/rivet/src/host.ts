import type { TelemetryListener } from "@syncmesh/engine";
import type {
  RelayHost,
  RelayLimits,
  RelayPosture,
  RelayRetention,
  RoomStore,
} from "@syncmesh/relay";

import { createRelayHost, describeRoom, relayEpoch, relayIdentity } from "@syncmesh/relay";
import { omitUndefined, panic } from "@syncmesh/result";
import { sqlBlobStore, sqliteEventStore } from "@syncmesh/storage";

import type { RivetDatabase } from "./driver.js";
import type { RivetWebSocket } from "./socket.js";

import { rivetSqlDriver } from "./driver.js";
import { bytesIn, rivetRelaySocket } from "./socket.js";

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
}

/** The two raw hooks of a Rivet actor definition, already wired to a room. */
export interface RelayRivetActor {
  /** `onWebSocket`: the posture first when the upgrade request is in hand, then the room. */
  readonly onWebSocket: (c: RivetRelayContext, ws: RivetWebSocket) => Promise<void>;
  /** `onRequest`: a plain `GET` describes the room; nothing here upgrades. */
  readonly onRequest: (c: RivetRelayContext, request: Request) => Promise<Response>;
}

/** WebSocket close code for a refusal the posture made: policy violation. */
const POLICY_VIOLATION = 1008;

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
 * @example
 * const relay = relayRivetActor({ posture });
 * export const room = actor({
 *   db: db(),
 *   onWebSocket: (c, ws) => relay.onWebSocket(c, ws),
 *   onRequest: (c, request) => relay.onRequest(c, request),
 * });
 */
export function relayRivetActor(options: RelayRivetActorOptions = {}): RelayRivetActor {
  /** One host per live instance; the hooks are shared by every instance the process runs. */
  const hosts = new Map<string, Promise<RelayHost>>();

  /**
   * The host for this instance, opened over the key kept in the actor's database: one actor is
   * one room, so the room's key is the host's, and the key a `GET` describes is the key the
   * hello signs with — across every sleep.
   */
  const open = async (c: RivetRelayContext): Promise<RelayHost> => {
    const driver = rivetSqlDriver(c.db);
    const identity = await relayIdentity(driver);
    const openRoomStore = async (): Promise<RoomStore> => {
      const store = (await sqliteEventStore(driver)).match({
        ok: (value) => value,
        err: (failure) => panic(`the room's log failed to open: ${failure.message}`),
      });
      const blobs =
        options.blobs === false
          ? undefined
          : (await sqlBlobStore(driver)).match({ ok: (value) => value, err: () => undefined });
      return {
        store,
        epoch: await relayEpoch(driver),
        ...omitUndefined({ blobs }),
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
    // asleep or destroyed, the instance's memory goes; its room is reopened from SQLite on wake
    c.abortSignal.addEventListener(
      "abort",
      () => {
        hosts.delete(c.actorId);
        void host.close();
      },
      { once: true },
    );
    return host;
  };

  const hostFor = (c: RivetRelayContext): Promise<RelayHost> => {
    const held = hosts.get(c.actorId) ?? open(c);
    hosts.set(c.actorId, held);
    return held;
  };

  return {
    onWebSocket: async (c, ws) => {
      const host = await hostFor(c);
      const name = roomName(c.key);
      if (c.request !== undefined) {
        const refused = await host.gate(c.request, name);
        if (refused !== undefined) {
          ws.close(POLICY_VIOLATION, (await refused.text()).slice(0, 120));
          return;
        }
      }
      ws.binaryType = "arraybuffer";
      const session = host.accept(rivetRelaySocket(ws), name);
      ws.addEventListener("message", (event) => {
        const bytes = bytesIn(event.data);
        if (bytes !== undefined) session.receive(bytes);
      });
      ws.addEventListener("close", () => session.closed());
    },
    // described under the actor's own name: Rivet's path is `/actors/<name>/http/…`, which is
    // routing, not a room
    onRequest: async (c, request) =>
      describeRoom(
        await hostFor(c),
        new Request(new URL(`/${roomName(c.key)}`, request.url).href, {
          method: request.method,
          headers: request.headers,
        }),
      ),
  };
}
