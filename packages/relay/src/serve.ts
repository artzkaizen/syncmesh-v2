import type { EventStore, TelemetryListener } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { Identity } from "@syncmesh/wire";

import { omitUndefined, panic } from "@syncmesh/result";

import type { Fanout } from "./fanout.js";
import type { RelayHost, RoomStore, RelayHostOptions, SocketSession } from "./host.js";
import type { RelayLimits } from "./limits.js";
import type { RelayPosture } from "./posture.js";
import type { RelayRetention } from "./retention.js";
import type { RelaySocket, SendOutcome } from "./sender.js";

import { describeRoom } from "./describe.js";
import { createRelayHost, durableRoomStore } from "./host.js";

export interface StartRelayOptions {
  /** Where the durable room logs live, one SQLite file per room. Default `.syncmesh/relay`. */
  readonly dataDir?: string;
  /** Your own log instead of the durable default; the relay then serves a single room. */
  readonly store?: EventStore;
  /** Only with `store`: its lineage id. A store without one gets one fresh epoch per process. */
  readonly epoch?: string;
  readonly keepaliveMs?: number;
  readonly pageSize?: number;
  readonly maxBacklog?: number;
  /** Protocol versions every room here accepts (D14); narrowing it raises the relay's floor. */
  readonly versions?: readonly number[];
  /** The key every room here signs its link hello with (D36). Absent, one fresh per process. */
  readonly identity?: Identity;
  /** Per-socket frame-size and rate ceilings; see `DEFAULT_LIMITS` for what each one costs. */
  readonly limits?: Partial<RelayLimits>;
  /** What every room here stops keeping: log age and blob bytes. Absent, nothing is ever dropped. */
  readonly retention?: RelayRetention;
  /**
   * How long a room with no socket on it is kept open before it is closed and its log handle
   * released. Absent, a room opened once is held for the life of the process. Its grant cache
   * outlives the eviction either way — see `createRoomTable` for why that one cannot be rebuilt.
   */
  readonly idleAfter?: Temporal.Duration;
  /** Who may open a socket, and onto which rooms: announce apart from access. */
  readonly posture?: RelayPosture;
  /** One listener for every room this host opens (D17); rooms open lazily, so it goes in here. */
  readonly onTelemetry?: TelemetryListener;
  readonly fanout?: Fanout;
  /** Serve blobs from the room's own database (D18). Default true; `false` for a log-only relay. */
  readonly blobs?: boolean;
}

export interface RunningRelay {
  readonly port: number;
  readonly url: string;
  /** The key every room here signs its link hello with (D36) — what a client pins with `relayKey`. */
  readonly peerId: PeerId;
  readonly stop: () => Promise<void>;
}

/** What a socket carries between Bun's callbacks: which room it asked for, and its session once bound. */
export interface SocketData {
  readonly room: string;
  session?: SocketSession;
}

/** Bun's log opener: one SQLite file per room under `dataDir`, epoch persisted with the log. */
export const bunRoomStore =
  (dataDir: string, serveBlobs: boolean) =>
  async (name: string): Promise<RoomStore> => {
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    const stores = (await defaultStore({ name: `relay-${name}`, dir: dataDir })).match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's log failed to open: ${failure.message}`),
    });
    return durableRoomStore(stores, { blobs: serveBlobs });
  };

/**
 * The host options that pass straight through to every room this host opens, absent keys left
 * absent. Shared by every mount that takes {@link StartRelayOptions} — Bun here, Node in
 * `@syncmesh/relay-node` — so the two cannot drift on which option reaches a room.
 */
export const hostTuning = (
  options: StartRelayOptions,
  openRoomStore: RelayHostOptions["openRoomStore"],
): RelayHostOptions =>
  omitUndefined({
    openRoomStore,
    singleRoom:
      options.store === undefined
        ? undefined
        : omitUndefined({ store: options.store, epoch: options.epoch }),
    keepaliveMs: options.keepaliveMs,
    pageSize: options.pageSize,
    maxBacklog: options.maxBacklog,
    versions: options.versions,
    identity: options.identity,
    limits: options.limits,
    retention: options.retention,
    idleAfter: options.idleAfter,
    posture: options.posture,
    onTelemetry: options.onTelemetry,
    fanout: options.fanout,
  });
/** The room a request's path names; `/` is `main`, and a leading slash is not part of the name. */
export const roomOf = (request: Request): string => {
  const path = new URL(request.url).pathname.replace(/^\/+/, "");
  return path === "" ? "main" : path;
};

/**
 * Whether a request is asking to become a socket at all. A plain `GET` on a room's path is
 * something else — a describe, a health check — and answering it with a 426 would be refusing
 * a question nobody asked.
 */
export const asksUpgrade = (request: Request): boolean =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

/**
 * The gate, then the upgrade: everything a fetch handler does before Bun's socket callbacks
 * take over. `undefined` means the socket is now the server's and no response is to be sent;
 * a `Response` is a refusal, or the answer to a request that never asked to upgrade.
 *
 * Runtime-neutral in shape — `upgrade` is Bun's `server.upgrade(request, { data })`, which the
 * single-port mount in `@syncmesh/orpc` hands through from its own fetch — and the reason this
 * is not inside {@link startRelay}: a server that answers procedures on the same port runs the
 * same gate and the same upgrade, and a second copy of either is where the two would drift.
 */
export async function upgradeRoom(
  host: RelayHost,
  request: Request,
  upgrade: (request: Request, options: { readonly data: SocketData }) => boolean,
): Promise<Response | undefined> {
  const room = host.roomFor(roomOf(request));
  // refused before a socket exists: a client the posture turns away costs the room nothing
  const refused = await host.gate(request, room);
  if (refused !== undefined) return refused;
  const upgraded = upgrade(request, { data: { room } });
  return upgraded ? undefined : new Response("syncmesh relay: WebSocket only", { status: 426 });
}

/** The `websocket` half of a `Bun.serve`, wired to a host; what {@link bunWebSocket} builds. */
export interface BunWebSocketHandlers {
  readonly open: (ws: BunSocket) => void;
  readonly message: (ws: BunSocket, message: string | Uint8Array) => void;
  readonly drain: (ws: BunSocket) => void;
  readonly close: (ws: BunSocket) => void;
}

/** The half of Bun's socket a room drives: what it sends on, and what it hangs up. */
export interface BunSocket {
  readonly data: SocketData;
  readonly send: (frame: Uint8Array) => number;
  readonly close: (code?: number, reason?: string) => void;
}

/**
 * Bun's four socket callbacks, wired to a host — the `websocket` half of `Bun.serve`. Structural
 * over the socket so a server that mounts procedures and custody on one port can hand these to
 * its own `Bun.serve` without this package naming Bun's types.
 */
export const bunWebSocket = (host: RelayHost): BunWebSocketHandlers => ({
  open(ws: BunSocket) {
    const socket: RelaySocket = {
      send: (frame): SendOutcome => {
        const sent = ws.send(frame);
        return sent === -1 ? "buffered" : sent === 0 ? "dropped" : "sent";
      },
      close: (reason) => ws.close(1000, reason),
    };
    ws.data.session = host.accept(socket, ws.data.room);
  },
  message(ws: BunSocket, message: string | Uint8Array) {
    // the protocol is binary; a text frame is noise
    if (!(message instanceof Uint8Array)) return;
    ws.data.session?.receive(message);
  },
  drain(ws: BunSocket) {
    ws.data.session?.drain();
  },
  close(ws: BunSocket) {
    ws.data.session?.closed();
  },
});

/**
 * D09-A: the embedded host — Bun's WebSocket server in the process you already run, one
 * durable SQLite log per room under `dataDir`, epoch persisted with the log. The room core
 * is host-agnostic (`createRelayHost`); this is merely its Bun mount. Port 0 picks a free port.
 */
export async function startRelay(
  port: number,
  options: StartRelayOptions = {},
): Promise<RunningRelay> {
  if (!("Bun" in globalThis))
    panic(
      "startRelay hosts the room over Bun.serve: run under Bun, or mount createRelayHost on your own socket server",
    );
  const dataDir = options.dataDir ?? ".syncmesh/relay";

  const host = createRelayHost(hostTuning(options, bunRoomStore(dataDir, options.blobs !== false)));

  // D09-A on purpose: this file IS the Bun mount; the guard above already refused other runtimes
  const server = globalThis.Bun.serve<SocketData>({
    port,
    // a socket for a device; a description for anything that asked without upgrading
    fetch: (request, self) =>
      asksUpgrade(request)
        ? upgradeRoom(host, request, (r, o) => self.upgrade(r, o))
        : describeRoom(host, request),
    websocket: bunWebSocket(host),
  });

  const boundPort = server.port ?? panic("Bun.serve did not bind a port");
  return {
    port: boundPort,
    url: `ws://localhost:${boundPort}`,
    peerId: host.peerId,
    stop: async () => {
      await host.close();
      await server.stop(true);
    },
  };
}
