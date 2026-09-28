import type { RelayDial } from "@syncmesh/relay";
import type { Database } from "bun:sqlite";

import type { DurableRelayContext, RelayDurableHostOptions } from "../host.js";
import type { DurableWebSocket } from "../socket.js";

import { toArrayBuffer } from "../driver.js";
import { relayDurableHost } from "../host.js";
import { durableSqlOver } from "./durable-sql.js";

const OPEN = 1;
const CLOSED = 3;

/**
 * How a socket reaches the object. Indirect on purpose: an eviction replaces the host instance
 * underneath sockets that never noticed, which is the whole thing worth testing.
 */
interface Delivery {
  readonly join: (ws: DurableWebSocket) => void;
  readonly message: (ws: DurableWebSocket, data: ArrayBuffer) => Promise<void>;
  readonly leave: (ws: DurableWebSocket) => void;
}

/** One accepted socket as both ends see it: the object's hibernatable half, and a client's dial. */
function dialOne(to: Delivery): RelayDial {
  const frames = new Set<(frame: Uint8Array) => void>();
  const closes = new Set<() => void>();
  let attachment: Uint8Array | null = null;
  let state = OPEN;
  // the room speaks first (D33) and the client subscribes after `dial()` returns: what was sent
  // in between waits, as bytes on the platform's socket would
  const backlog: Uint8Array[] = [];

  const server: DurableWebSocket = {
    get readyState() {
      return state;
    },
    send: (data) => {
      if (!(data instanceof Uint8Array)) return;
      if (frames.size === 0) {
        backlog.push(data);
        return;
      }
      for (const cb of [...frames]) cb(data);
    },
    close: () => shut(),
    serializeAttachment: (value) => void (attachment = value),
    deserializeAttachment: () => attachment,
  };

  const shut = (): void => {
    if (state === CLOSED) return;
    state = CLOSED;
    to.leave(server);
    for (const cb of [...closes]) cb();
  };

  to.join(server);
  return {
    send: (frame) => {
      if (state !== OPEN) throw new Error("relay socket is not open");
      void to.message(server, toArrayBuffer(frame));
    },
    onFrame: (cb) => {
      frames.add(cb);
      for (const bytes of backlog.splice(0)) cb(bytes);
      return () => void frames.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => shut(),
  };
}

/**
 * A Durable Object as the platform runs one: SQLite that outlives the instance, a list of
 * accepted sockets that outlives it too, and an instance that does not.
 */
export function durableRelay(db: Database, options: RelayDurableHostOptions = {}) {
  const accepted: DurableWebSocket[] = [];
  const ctx: DurableRelayContext = {
    storage: { sql: durableSqlOver(db) },
    acceptWebSocket: (ws) => void accepted.push(ws),
    // the platform lists the live ones; a socket that closed while the object slept is gone
    getWebSockets: () => accepted.filter((ws) => ws.readyState === OPEN),
  };
  let host = relayDurableHost(ctx, options);
  const to: Delivery = {
    join: (ws) => host.join(ws),
    message: (ws, data) => host.message(ws, data),
    leave: (ws) => host.leave(ws),
  };
  return {
    dial: (): RelayDial => dialOne(to),
    /** Eviction: the instance's memory is reset while its sockets and its SQLite are not. */
    evict: () => void (host = relayDurableHost(ctx, options)),
  };
}
