import type { WindowRow } from "./frames.js";
import type { WindowQuery } from "./query.js";

import { decodeWindowFrame, desireFrame, undesireFrame } from "./frames.js";
import { queryText } from "./query.js";
import { createPatchStream } from "./stream.js";

/**
 * `live` when the last patch applied in order; `resyncing` after a gap, until the reset arrives;
 * `detached` with no socket to speak on.
 */
export type WindowStatus = "live" | "resyncing" | "detached";

/**
 * A client with no store (E27, D39): it holds the rows its windows show and nothing else. It
 * folds nothing, keeps no cursor and checks no signature. It trusts whoever serves the windows
 * for what a row says, as a REST client trusts its API.
 *
 * It **cannot write**. There is no log to append to and no key to sign with, so a write goes
 * through the app's procedures on the server, and the window then shows the committed row.
 * Offline it shows the last rows it was sent, and nothing newer.
 */
export interface WindowClient {
  /** Opens a window, or moves the one under `id` (a scroll is a new `after` on the same id). */
  readonly desire: (id: string, query: WindowQuery) => void;
  readonly undesire: (id: string) => void;
  /** One window's rows in its order. */
  readonly rows: (id: string) => readonly WindowRow[];
  /** Why the server refused a window, if it did. */
  readonly refusal: (id: string) => string | undefined;
  readonly status: () => WindowStatus;
  /** Distinct rows held across every window. */
  readonly held: () => number;
  /**
   * Feeds the client one frame off the socket. Returns `false` for a frame that is not a window
   * frame, which the caller hands to whatever else shares the socket.
   */
  readonly receive: (bytes: Uint8Array) => boolean;
  /**
   * Speaks on a new socket and re-desires every window. A new socket is a new view, so its first
   * patch is a reset, and what was held before stays on screen until that reset arrives.
   */
  readonly attach: (send: (frame: Uint8Array) => void) => void;
  readonly detach: () => void;
  /** Called after every patch that lands. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createWindowClient(): WindowClient {
  const stream = createPatchStream();
  const queries = new Map<string, WindowQuery>();
  const refusals = new Map<string, string>();
  const listeners = new Set<() => void>();
  let send: ((frame: Uint8Array) => void) | undefined;
  let resyncing = false;

  /** A gap: ask again from where this stream stands, and the server answers with a reset. */
  const resync = (): void => {
    const first = [...queries][0];
    if (resyncing || send === undefined || first === undefined) return;
    resyncing = true;
    send(desireFrame(first[0], queryText(first[1]), stream.position()));
  };

  return {
    desire: (id, query) => {
      queries.set(id, query);
      refusals.delete(id);
      send?.(desireFrame(id, queryText(query)));
    },
    undesire: (id) => {
      queries.delete(id);
      stream.forget(id);
      send?.(undesireFrame(id));
    },
    rows: (id) => stream.rows(id),
    refusal: (id) => refusals.get(id),
    status: () => (send === undefined ? "detached" : resyncing ? "resyncing" : "live"),
    held: () => stream.held(),
    receive: (bytes) => {
      const decoded = decodeWindowFrame(bytes);
      if (decoded.isErr()) {
        // a frame that says it is a patch and does not read as one is a patch lost
        resync();
        return true;
      }
      const frame = decoded.value;
      if (frame?.kind !== "rows") return frame !== undefined;
      if (stream.apply(frame) === "gap") {
        resync();
        return true;
      }
      if (frame.reset) resyncing = false;
      for (const { id, reason } of frame.refused) refusals.set(id, reason);
      for (const listener of listeners) listener();
      return true;
    },
    attach: (next) => {
      send = next;
      resyncing = false;
      for (const [id, query] of queries) next(desireFrame(id, queryText(query)));
    },
    detach: () => {
      send = undefined;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
