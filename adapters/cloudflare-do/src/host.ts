import type { RelayConnection, RelayRoom } from "@syncmesh/relay";
import type { BlobStore, SqliteDriver } from "@syncmesh/storage";

import { decodeRelayFrame, openRelayRoom } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { sqlBlobStore, sqliteEventStore } from "@syncmesh/storage";

import type { DurableSqlStorage } from "./driver.js";
import type { DurableWebSocket } from "./socket.js";

import { doSqliteDriver } from "./driver.js";
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
}

/** The three callbacks of a hibernating WebSocket object, already wired to a room. */
export interface RelayDurableHost {
  /** Accepts the socket for hibernation; its connection is built when its `join` frame lands. */
  readonly join: (ws: DurableWebSocket) => void;
  readonly message: (ws: DurableWebSocket, data: ArrayBuffer | string) => Promise<void>;
  readonly leave: (ws: DurableWebSocket) => void;
}

/** `serializeAttachment` refuses more than 16 KiB, and a throw here would reset the object. */
const ATTACHMENT_LIMIT = 16_000;

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
 * @example
 * export class Relay extends DurableObject<Env> {
 *   #relay = relayDurableHost(this.ctx);
 *   override async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string) {
 *     await this.#relay.message(ws, data);
 *   }
 * }
 */
export function relayDurableHost(
  ctx: DurableRelayContext,
  options: RelayDurableHostOptions = {},
): RelayDurableHost {
  const live = new Map<DurableWebSocket, RelayConnection>();
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
      ...(blobs !== undefined && { blobs }),
    });
    return room.match({
      ok: (value) => value,
      err: (failure) => panic(`the room failed to open: ${failure.message}`),
    });
  };

  /**
   * Every socket the object holds, bound to the room. `waking` is the socket whose own frame is
   * a fresh `join`: replaying its stored one as well would be a second join on one socket, which
   * the room answers by closing the socket the newer join superseded — itself.
   */
  const restore = async (waking: DurableWebSocket | undefined): Promise<void> => {
    const room = await (opening ??= open());
    for (const ws of ctx.getWebSockets()) {
      if (live.has(ws)) continue;
      const conn = room.connect(durableRelaySocket(ws));
      live.set(ws, conn);
      const rejoin = ws === waking ? null : ws.deserializeAttachment();
      // a socket with nothing kept never joined, or joined with cursors too wide to keep; either
      // way it is left bound and silent, and its next frame gets the room's `join-first` refusal
      if (rejoin !== null) conn.receive(rejoin);
    }
  };

  return {
    join: (ws) => ctx.acceptWebSocket(ws),
    message: async (ws, data) => {
      // the protocol is binary; a text frame is noise
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      // decoded here only to notice a join — the connection decodes it again, which is the price
      // of a resume point the object can rebuild itself from after an eviction
      const decoded = decodeRelayFrame(bytes);
      const joining = decoded.isOk() && decoded.value.kind === "join";
      await restore(joining ? ws : undefined);
      if (joining && bytes.length <= ATTACHMENT_LIMIT) ws.serializeAttachment(bytes);
      live.get(ws)?.receive(bytes);
    },
    leave: (ws) => {
      const conn = live.get(ws);
      live.delete(ws);
      conn?.closed();
    },
  };
}
