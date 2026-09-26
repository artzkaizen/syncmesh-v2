import type { TelemetryListener } from "@syncmesh/engine";
import type { RelayConnection, RelayLimits, RelayRoom } from "@syncmesh/relay";
import type { BlobStore, SqliteDriver } from "@syncmesh/storage";

import { decodeRelayFrame, openRelayRoom } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { sqlBlobStore, sqliteEventStore } from "@syncmesh/storage";

import type { DurableSqlStorage } from "./driver.js";
import type { DurableWebSocket } from "./socket.js";

import { doSqliteDriver } from "./driver.js";
import { decodeResume, trackResume } from "./resume.js";
import { durableRelaySocket } from "./socket.js";

/**
 * What a Durable Object hands its room: its SQLite, and the two calls that make a socket
 * hibernatable. Methods rather than function-typed properties so a real `DurableObjectState`
 * — whose `acceptWebSocket` names the platform's wider `WebSocket` — still satisfies it.
 */
export interface DurableRelayContext {
  readonly storage: { readonly sql: DurableSqlStorage };
  acceptWebSocket(ws: DurableWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): DurableWebSocket[];
}

export interface RelayDurableHostOptions {
  /**
   * The room's name. The platform routes every socket for a room to one object, so this labels
   * the log rather than addressing it — and it is why there is no `fanout` here: an actor shape
   * has no second instance to gossip with (D09-C).
   */
  readonly name?: string;
  readonly keepaliveMs?: number;
  readonly pageSize?: number;
  readonly maxBacklog?: number;
  /** Serve blobs from the object's own SQLite (D18). Default true; `false` for a log-only room. */
  readonly blobs?: boolean;
  /**
   * Per-socket ceilings — frame size and the two token buckets. Forwarded whole, because a
   * partly-overridden rate table is a table where the class nobody thought about is left open.
   */
  readonly limits?: Partial<RelayLimits>;
  /** Protocol versions this room accepts (D14); narrowing it is how an operator raises the floor. */
  readonly versions?: readonly number[];
  /**
   * A telemetry listener from the first frame on (D17). The room is opened lazily behind the
   * first socket, so this is the only subscription point a host has that is early enough.
   */
  readonly onTelemetry?: TelemetryListener;
}

/** The three callbacks of a hibernating WebSocket object, already wired to a room. */
export interface RelayDurableHost {
  /** Accepts the socket for hibernation and binds it to the room, whose challenge is its first frame (D33). */
  readonly join: (ws: DurableWebSocket) => void;
  readonly message: (ws: DurableWebSocket, data: ArrayBuffer | string) => Promise<void>;
  readonly leave: (ws: DurableWebSocket) => void;
}

/**
 * The room's lineage id, kept in the object's own SQLite beside the log it describes. An object
 * evicted, redeployed or moved between regions keeps it, so a visibility token minted before the
 * move still means what it meant; only a reset database is honestly a new room.
 */
async function epochOf(driver: SqliteDriver): Promise<string> {
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

const openBlobs = async (driver: SqliteDriver): Promise<BlobStore | undefined> => {
  const opened = await sqlBlobStore(driver);
  return opened.isOk() ? opened.value : undefined;
};

/**
 * D09-C: the room mounted in one actor. The platform routes every socket for a room to this
 * object, so there is no fleet to gossip with and no Redis — the fan-out port stays unused and
 * the log is the object's own SQLite, durable, single-writer and multi-region from the host.
 *
 * The object is evicted whenever it goes quiet, and its sockets survive that. Nothing of the
 * room survives it: the log is on disk, but the client table, the grant cache and the presence
 * tier are memory. So the first frame after a wake rebuilds **every** socket this object holds,
 * not just the one that woke it — a device left out of the rebuilt client table would keep
 * appending to the log while hearing nothing back, and two devices holding the same events would
 * disagree until one of them reconnected.
 *
 * All three callbacks are load-bearing: `join` is what accepts the socket for hibernation, and
 * `leave` is what takes a closed one out of the room's client table.
 *
 * @example
 * export class Relay extends DurableObject<Env> {
 *   #relay = relayDurableHost(this.ctx);
 *   override fetch(request: Request) {
 *     const { 0: client, 1: server } = new WebSocketPair();
 *     this.#relay.join(server);
 *     return new Response(null, { status: 101, webSocket: client });
 *   }
 *   override async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string) {
 *     await this.#relay.message(ws, data);
 *   }
 *   override webSocketClose(ws: WebSocket) {
 *     this.#relay.leave(ws);
 *   }
 * }
 */
export function relayDurableHost(
  ctx: DurableRelayContext,
  options: RelayDurableHostOptions = {},
): RelayDurableHost {
  const live = new Map<DurableWebSocket, RelayConnection>();
  const resume = trackResume();
  let opening: Promise<RelayRoom> | undefined;

  const open = async (): Promise<RelayRoom> => {
    const driver = doSqliteDriver(ctx.storage.sql);
    const store = (await sqliteEventStore(driver)).match({
      ok: (value) => value,
      err: (failure) => panic(`the room's log failed to open: ${failure.message}`),
    });
    const epoch = await epochOf(driver);
    const blobs = options.blobs === false ? undefined : await openBlobs(driver);
    const room = await openRelayRoom({
      name: options.name ?? "main",
      store,
      epoch,
      ...(options.keepaliveMs !== undefined && { keepaliveMs: options.keepaliveMs }),
      ...(options.pageSize !== undefined && { pageSize: options.pageSize }),
      ...(options.maxBacklog !== undefined && { maxBacklog: options.maxBacklog }),
      ...(options.limits !== undefined && { limits: options.limits }),
      ...(options.versions !== undefined && { versions: options.versions }),
      ...(options.onTelemetry !== undefined && { onTelemetry: options.onTelemetry }),
      ...(blobs !== undefined && { blobs }),
    });
    return room.match({
      ok: (value) => value,
      err: (failure) => panic(`the room failed to open: ${failure.message}`),
    });
  };

  /**
   * Every socket the object holds, bound to the room and handed its script back. `waking` is the
   * socket whose own frame is a fresh `join`: replaying its stored one as well would be a second
   * join on one socket, which the room answers by closing the socket the newer join superseded —
   * itself.
   */
  const restore = async (waking: DurableWebSocket | undefined): Promise<void> => {
    const room = await (opening ??= open());
    for (const ws of ctx.getWebSockets()) {
      if (live.has(ws)) continue;
      const kept = decodeResume(ws.deserializeAttachment());
      // a socket challenged before the object slept is handed the same challenge back, so the
      // join it is about to send — or the one replayed below — still verifies (D33); one never
      // challenged is challenged now, and the nonce is kept before anything else is
      const conn = room.connect(
        durableRelaySocket(ws),
        kept.nonce === undefined ? {} : { challenge: kept.nonce },
      );
      live.set(ws, conn);
      if (kept.nonce === undefined) resume.challenged(ws, conn.challenge);
      else resume.restored(ws, kept);
      // a socket with nothing kept never joined, or joined with a script too wide to keep; either
      // way it is left bound and silent, and its next frame gets the room's `join-first` refusal
      if (ws !== waking) for (const frame of kept.frames) conn.receive(frame);
    }
  };

  return {
    // bound at once rather than on the first frame: the room speaks first now, and a socket that
    // is never told the challenge never sends a join the room would accept
    join: (ws) => {
      ctx.acceptWebSocket(ws);
      void restore(undefined);
    },
    message: async (ws, data) => {
      // the protocol is binary; a text frame is noise
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      // decoded here only to notice what belongs in the resume script — the connection decodes it
      // again, which is the price of a resume point the object can rebuild itself from
      const decoded = decodeRelayFrame(bytes);
      const frame = decoded.isOk() ? decoded.value : undefined;
      const joining = frame?.kind === "join";
      await restore(joining ? ws : undefined);
      if (joining) resume.joined(ws, bytes);
      else if (frame?.kind === "session" && frame.frame.kind === "grant") resume.granted(ws, bytes);
      live.get(ws)?.receive(bytes);
    },
    leave: (ws) => {
      const conn = live.get(ws);
      live.delete(ws);
      resume.forget(ws);
      conn?.closed();
    },
  };
}
