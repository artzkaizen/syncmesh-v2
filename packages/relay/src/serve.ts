import type { EventStore, TelemetryListener } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { BlobStore } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { Identity } from "@syncmesh/wire";

import { omitUndefined, panic } from "@syncmesh/result";

import type { Fanout } from "./fanout.js";
import type { RoomStore, RelayHostOptions, SocketSession } from "./host.js";
import type { RelayLimits } from "./limits.js";
import type { RelayPosture } from "./posture.js";
import type { RelayRetention } from "./retention.js";
import type { RelaySocket, SendOutcome } from "./sender.js";

import { createRelayHost, epochOf } from "./host.js";

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

interface SocketData {
  readonly room: string;
  session?: SocketSession;
}

/** Bun's log opener: one SQLite file per room under `dataDir`, epoch persisted with the log. */
const bunRoomStore =
  (dataDir: string, serveBlobs: boolean) =>
  async (name: string): Promise<RoomStore> => {
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    const stores = (await defaultStore({ name: `relay-${name}`, dir: dataDir })).match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's log failed to open: ${failure.message}`),
    });
    const driver = stores.driver ?? panic("defaultStore always carries its driver");
    // this room's own blob store, never shared across rooms: a room that inherited
    // another room's store would serve and keep another room's bytes under D18
    let blobs: BlobStore | undefined;
    if (serveBlobs) {
      const { sqlBlobStore } = await import("@syncmesh/storage");
      const opened = await sqlBlobStore(driver);
      if (opened.isOk()) blobs = opened.value;
    }
    return {
      store: stores.events,
      epoch: await epochOf(driver),
      ...omitUndefined({ blobs }),
      release: stores.close,
    };
  };

/** The host options that pass straight through to every room this host opens, absent keys left absent. */
const hostTuning = (
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
    async fetch(request, self) {
      const path = new URL(request.url).pathname.replace(/^\/+/, "");
      const room = path === "" ? "main" : path;
      // refused before a socket exists: a client the posture turns away costs the room nothing
      const refused = await host.gate(request, room);
      if (refused !== undefined) return refused;
      const upgraded = self.upgrade(request, { data: { room } });
      return upgraded ? undefined : new Response("syncmesh relay: WebSocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        const socket: RelaySocket = {
          send: (frame): SendOutcome => {
            const sent = ws.send(frame);
            return sent === -1 ? "buffered" : sent === 0 ? "dropped" : "sent";
          },
          close: (reason) => ws.close(1000, reason),
        };
        ws.data.session = host.accept(socket, ws.data.room);
      },
      message(ws, message) {
        // the protocol is binary; a text frame is noise
        if (!(message instanceof Uint8Array)) return;
        ws.data.session?.receive(message);
      },
      drain(ws) {
        ws.data.session?.drain();
      },
      close(ws) {
        ws.data.session?.closed();
      },
    },
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
