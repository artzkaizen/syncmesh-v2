import type { EventStore, TelemetryListener } from "@syncmesh/engine";
import type { BlobStore, SqlDriver } from "@syncmesh/storage";

import { panic } from "@syncmesh/result";

import type { Fanout } from "./fanout.js";
import type { RelayLimits } from "./limits.js";
import type { RelayPosture } from "./posture.js";
import type { RelayConnection, RelayRoom, RelayRoomOptions } from "./room.js";
import type { RelaySocket, SendOutcome } from "./sender.js";

import { createRoomAccess } from "./posture.js";
import { openRelayRoom } from "./room.js";

/** What a host passes through to each room it opens; the room's own name and store are its business. */
type RoomTuning = Partial<
  Pick<
    RelayRoomOptions,
    | "keepaliveMs"
    | "pageSize"
    | "maxBacklog"
    | "versions"
    | "limits"
    | "fanout"
    | "blobs"
    | "onTelemetry"
  >
>;

export interface StartRelayOptions {
  /** Where the durable room logs live, one SQLite file per room. Default `.syncmesh/relay`. */
  readonly dataDir?: string;
  /** Your own log instead of the durable default; the relay then serves a single room. */
  readonly store?: EventStore;
  /** Only with `store`: its lineage id. A store without one gets a fresh epoch every boot. */
  readonly epoch?: string;
  readonly keepaliveMs?: number;
  readonly pageSize?: number;
  readonly maxBacklog?: number;
  /** Protocol versions every room here accepts (D14); narrowing it raises the relay's floor. */
  readonly versions?: readonly number[];
  /** Per-socket frame-size and rate ceilings; see `DEFAULT_LIMITS` for what each one costs. */
  readonly limits?: Partial<RelayLimits>;
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
  readonly stop: () => Promise<void>;
}

/** The epoch rides in the log's own file: a new file is honestly a new lineage. */
async function epochOf(driver: SqlDriver): Promise<string> {
  await driver.run(
    `CREATE TABLE IF NOT EXISTS "_relay_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
  );
  const held = await driver.all(`SELECT "value" FROM "_relay_meta" WHERE "key" = 'epoch'`);
  const value = held[0]?.[0];
  if (value !== undefined && value !== null) return String(value); // the column is TEXT NOT NULL
  const fresh = crypto.randomUUID();
  await driver.run(`INSERT INTO "_relay_meta" ("key", "value") VALUES ('epoch', ?)`, [fresh]);
  return fresh;
}

interface SocketData {
  readonly room: string;
  conn?: RelayConnection;
  /** Frames that raced the async room open; flushed the moment the connection exists. */
  pending?: Uint8Array[];
}

/**
 * D09-A: the embedded host — Bun's WebSocket server in the process you already run, one
 * durable SQLite log per room under `dataDir`, epoch persisted with the log. The room core
 * is host-agnostic; this is merely its first mount. Port 0 picks a free port.
 */
export async function startRelay(
  port: number,
  options: StartRelayOptions = {},
): Promise<RunningRelay> {
  if (!("Bun" in globalThis))
    panic(
      "startRelay hosts the room over Bun.serve: run under Bun, or mount openRelayRoom on your own socket server",
    );
  const dataDir = options.dataDir ?? ".syncmesh/relay";
  const access = createRoomAccess(options.posture);
  const roomOptions: RoomTuning = {
    ...(options.keepaliveMs !== undefined && { keepaliveMs: options.keepaliveMs }),
    ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
    ...(options.maxBacklog !== undefined && { maxBacklog: options.maxBacklog }),
    ...(options.versions !== undefined && { versions: options.versions }),
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.onTelemetry !== undefined && { onTelemetry: options.onTelemetry }),
    ...(options.fanout !== undefined && { fanout: options.fanout }),
  };

  const rooms = new Map<string, Promise<RelayRoom>>();
  const closers: (() => Promise<void> | void)[] = [];

  const open = async (name: string): Promise<RelayRoom> => {
    if (options.store !== undefined) {
      const room = await openRelayRoom({
        ...roomOptions,
        name,
        store: options.store,
        epoch: options.epoch ?? crypto.randomUUID(),
      });
      return room.match({
        ok: (value) => value,
        err: (failure) => panic(`the relay's store failed to open: ${failure.message}`),
      });
    }
    const { defaultStore } = await import("@syncmesh/sqlite-bun");
    const stores = (await defaultStore({ name: `relay-${name}`, dir: dataDir })).match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's log failed to open: ${failure.message}`),
    });
    closers.push(stores.close);
    const driver = stores.driver ?? panic("defaultStore always carries its driver");
    // this room's own blob store, never written back into the shared tuning: the rooms are opened
    // one after another, and a room that inherited the previous one's store would serve and keep
    // another room's bytes under D18
    let blobs: BlobStore | undefined;
    if (options.blobs !== false) {
      const { sqlBlobStore } = await import("@syncmesh/storage");
      const opened = await sqlBlobStore(driver);
      if (opened.isOk()) blobs = opened.value;
    }
    const room = await openRelayRoom({
      ...roomOptions,
      ...(blobs !== undefined && { blobs }),
      name,
      store: stores.events,
      epoch: await epochOf(driver),
    });
    return room.match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's store failed to open: ${failure.message}`),
    });
  };

  const roomFor = (name: string): Promise<RelayRoom> => {
    // a caller-supplied store is one log: it serves one room whatever the path says
    const key = options.store !== undefined ? "main" : name;
    const held = rooms.get(key) ?? open(key);
    rooms.set(key, held);
    return held;
  };

  // D09-A on purpose: this file IS the Bun mount; the guard above already refused other runtimes
  const server = globalThis.Bun.serve<SocketData>({
    port,
    async fetch(request, self) {
      const path = new URL(request.url).pathname.replace(/^\/+/, "");
      const room = path === "" ? "main" : path;
      // refused before a socket exists: a client the posture turns away costs the room nothing
      if (!access.admitsOrigin(request.headers.get("origin")))
        return new Response("syncmesh relay: origin not allowed", { status: 403 });
      if (!access.announces(room))
        return new Response("syncmesh relay: no such room", { status: 404 });
      if (!(await access.admitsJoin(request, room)))
        return new Response("syncmesh relay: join refused", { status: 403 });
      const upgraded = self.upgrade(request, { data: { room } });
      return upgraded ? undefined : new Response("syncmesh relay: WebSocket only", { status: 426 });
    },
    websocket: {
      async open(ws) {
        const room = await roomFor(ws.data.room);
        const socket: RelaySocket = {
          send: (frame): SendOutcome => {
            const sent = ws.send(frame);
            return sent === -1 ? "buffered" : sent === 0 ? "dropped" : "sent";
          },
          close: (reason) => ws.close(1000, reason),
        };
        const conn = room.connect(socket);
        ws.data.conn = conn;
        for (const frame of ws.data.pending ?? []) conn.receive(frame);
        delete ws.data.pending;
      },
      message(ws, message) {
        // the protocol is binary; a text frame is noise
        if (!(message instanceof Uint8Array)) return;
        const bytes = message;
        if (ws.data.conn === undefined) (ws.data.pending ??= []).push(bytes);
        else ws.data.conn.receive(bytes);
      },
      drain(ws) {
        ws.data.conn?.drain();
      },
      close(ws) {
        ws.data.conn?.closed();
      },
    },
  });

  const boundPort = server.port ?? panic("Bun.serve did not bind a port");
  return {
    port: boundPort,
    url: `ws://localhost:${boundPort}`,
    stop: async () => {
      for (const room of rooms.values()) (await room).close();
      await server.stop(true);
      for (const close of closers) await close();
    },
  };
}
