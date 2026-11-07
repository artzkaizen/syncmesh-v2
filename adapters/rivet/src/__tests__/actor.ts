import type { RelayDial } from "@syncmesh/relay";
import type { Database } from "bun:sqlite";

import { omitUndefined } from "@syncmesh/result";

import type { RivetDatabase, RivetSqlRow, RivetSqlValue } from "../driver.js";
import type { RelayRivetActor, RivetRelayContext } from "../host.js";
import type { RivetWebSocket } from "../socket.js";

const OPEN = 1;
const CLOSED = 3;

/**
 * A stand-in for `c.db` over `bun:sqlite` that keeps the two things a driver could get wrong
 * against the real one: rows come back as **objects** keyed by column name, and only Rivet's
 * value set binds — no boolean, no `Date`. It is not a stand-in for Rivet's SQLite engine.
 */
export function rivetDbOver(db: Database): RivetDatabase {
  const execute = async (query: string, ...args: RivetSqlValue[]) => {
    // the platform's own binding check: a value outside its set is refused, never coerced.
    // SAFETY: widened to ask about values the type already excludes — the point of the check
    const outside = (args as readonly unknown[]).find(
      (value) => value === true || value === false || value instanceof Date,
    );
    if (outside !== undefined)
      throw new TypeError(`unsupported sqlite binding: ${String(outside)}`);
    // SAFETY: bun:sqlite's object rows are what Rivet's `execute` answers — column name to text,
    // integer, real, blob or NULL — and its bindings take the same value set this one admits
    return (db.query(query).all(...(args as never[])) ?? []) as RivetSqlRow[];
  };
  const self: RivetDatabase = {
    execute,
    transaction: async (callback) => {
      db.run("BEGIN");
      try {
        const result = await callback({ execute });
        db.run("COMMIT");
        return result;
      } catch (cause) {
        db.run("ROLLBACK");
        throw cause;
      }
    },
  };
  return self;
}

/** One socket as both ends see it: the actor's raw WebSocket, and a client's dial. */
function socketPair(
  onOpen: (ws: RivetWebSocket) => void,
  codes: (number | undefined)[],
): RelayDial {
  const toClient = new Set<(frame: Uint8Array) => void>();
  const closes = new Set<() => void>();
  type Listener = Parameters<RivetWebSocket["addEventListener"]>[1];
  const messageListeners: Listener[] = [];
  const closeListeners: Listener[] = [];
  const backlog: Uint8Array[] = [];
  let state = OPEN;

  const shut = (): void => {
    if (state === CLOSED) return;
    state = CLOSED;
    for (const listener of closeListeners) listener({});
    for (const cb of closes) cb();
  };

  const server: RivetWebSocket = {
    get readyState() {
      return state;
    },
    send: (data) => {
      if (toClient.size === 0) backlog.push(data);
      else for (const cb of toClient) cb(data);
    },
    close: (code) => {
      if (state !== CLOSED) codes.push(code);
      shut();
    },
    addEventListener: (type, listener) => {
      (type === "message" ? messageListeners : closeListeners).push(listener);
    },
  };
  onOpen(server);

  return {
    send: (frame) => {
      if (state !== OPEN) throw new Error("socket is not open");
      // as an ArrayBuffer, the way `binaryType = "arraybuffer"` delivers it
      const copy = frame.slice().buffer;
      for (const listener of messageListeners) listener({ data: copy });
    },
    onFrame: (cb) => {
      toClient.add(cb);
      for (const bytes of backlog.splice(0)) cb(bytes);
      return () => void toClient.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => shut(),
  };
}

/**
 * An actor as the runtime runs one: SQLite that outlives the instance, and an instance whose
 * memory does not — `sleep` aborts its signal and the next socket meets a fresh one.
 */
export function rivetActor(db: Database, relay: RelayRivetActor, key: readonly string[]) {
  let instance = 0;
  let abort = new AbortController();
  const context = (request?: Request): RivetRelayContext => ({
    actorId: `actor-${instance}`,
    key,
    db: rivetDbOver(db),
    abortSignal: abort.signal,
    ...omitUndefined({ request }),
  });
  /** The code of every socket the actor closed, in order; `undefined` for one closed without. */
  const closeCodes: (number | undefined)[] = [];
  return {
    closeCodes,
    dial: (request?: Request): RelayDial =>
      socketPair((ws) => void relay.onWebSocket(context(request), ws), closeCodes),
    describe: (request: Request) => relay.onRequest(context(), request),
    /** The actor goes to sleep: its memory and its sockets go, its SQLite stays. */
    sleep: () => {
      abort.abort();
      abort = new AbortController();
      instance += 1;
    },
  };
}
