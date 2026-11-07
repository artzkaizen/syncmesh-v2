import type { StreamPosition, WindowRow } from "./frames.js";
import type { ReadRequest } from "./request.js";
import type { PatchStream } from "./stream.js";

import { decodeWindowFrame, desireFrame, undesireFrame } from "./frames.js";
import { requestText } from "./request.js";
import { createPatchStream } from "./stream.js";

/** A position no view is ever at: a view's versions start at 1. */
const NOWHERE = { epoch: "", version: 0 } as const satisfies StreamPosition;

/**
 * `live` when the last patch applied in order; `resyncing` after a gap or a reconnect, until the
 * new stream holds every window; `detached` with no socket to speak on.
 */
export type WindowStatus = "live" | "resyncing" | "detached";

/**
 * The device's end of the windows a socket carries (E27, D39): it holds the rows its windows
 * show and nothing else. It folds nothing, keeps no cursor and checks no signature. It trusts the
 * server for what a row says, as a REST client trusts its API.
 *
 * An app never calls it. `createClient({ windows })` hands it to the api, and a `query`
 * procedure that reads a `sync: "window"` table opens and closes windows through it while
 * `useLiveQuery` holds the call. Writes go through the app's procedures, and the window then
 * shows the committed row. Offline it shows the last rows it was sent, and nothing newer.
 */
export interface WindowClient {
  /** Opens a window, or moves the one under `id` to another read (the next page). */
  readonly open: (id: string, request: ReadRequest) => void;
  readonly close: (id: string) => void;
  /** One window's rows in its order. */
  readonly rows: (id: string) => readonly WindowRow[];
  /** Whether the server has sent this window yet; an empty page is sent, a pending one is not. */
  readonly arrived: (id: string) => boolean;
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
   * patch is a reset. What was held before stays on screen, and is what {@link rows} returns,
   * until the new view has named or refused every window the client desires.
   */
  readonly attach: (send: (frame: Uint8Array) => void) => void;
  readonly detach: () => void;
  /** Called after every patch that lands. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createWindowClient(): WindowClient {
  /** What the screen shows. */
  let shown = createPatchStream();
  /**
   * The stream being rebuilt after a reconnect or a gap, and the windows it has named or refused
   * so far. It replaces {@link shown} once it accounts for every window the client desires, so a
   * reset that names only some of them never blanks the rest. The reset that answers a gap
   * names every window the view holds open, so it accounts for every desired window: one it
   * leaves out was refused, perhaps in the very patch that went missing.
   */
  let pending: { readonly stream: PatchStream; readonly settled: Set<string> } | undefined;
  const requests = new Map<string, ReadRequest>();
  const refusals = new Map<string, string>();
  const listeners = new Set<() => void>();
  let send: ((frame: Uint8Array) => void) | undefined;
  /**
   * A resnapshot was asked for and its reset has not arrived. `before` is the epoch of the patches
   * the view sent before it read the ask, when the client knows it. Every reset starts a new
   * epoch, so a patch in any other epoch proves the answering reset was lost.
   */
  let asked: { readonly before: string | undefined } | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** Swaps the rebuilt stream in once every desired window is in it. */
  const settle = (): void => {
    if (pending === undefined) return;
    for (const id of requests.keys()) if (!pending.settled.has(id)) return;
    shown = pending.stream;
    pending = undefined;
    notify();
  };

  /**
   * A gap: ask again from where the stream that missed a patch stands, and the server answers
   * with a reset. Before the first reset there is no position, so the client names
   * {@link NOWHERE}, which no server stream is at. With no window desired there is nothing to
   * ask for; the next desire's patch is a gap again and asks then. `seen` is the epoch of the
   * patch that showed the gap, which the stale patches still on the socket share.
   */
  const resync = (missed: PatchStream, seen?: string): void => {
    const first = [...requests][0];
    if (asked !== undefined || send === undefined || first === undefined) return;
    const since = missed.position() ?? NOWHERE;
    asked = { before: missed.position()?.epoch ?? seen };
    pending ??= { stream: createPatchStream(), settled: new Set() };
    send(desireFrame(first[0], requestText(first[1]), since));
  };

  /**
   * A patch in `epoch` did not land. While an ask is out, one in the epoch the ask was sent from
   * was already on the socket and asks nothing; one in any other epoch comes after a reset this
   * client never saw, so the answer was lost and the client asks again.
   */
  const gap = (target: PatchStream, epoch: string): void => {
    if (asked !== undefined) {
      if (asked.before === undefined) asked = { before: epoch };
      else if (asked.before !== epoch) asked = undefined;
    }
    resync(target, epoch);
  };

  return {
    open: (id, request) => {
      requests.set(id, request);
      refusals.delete(id);
      send?.(desireFrame(id, requestText(request)));
    },
    close: (id) => {
      requests.delete(id);
      shown.forget(id);
      pending?.stream.forget(id);
      send?.(undesireFrame(id));
      settle();
    },
    rows: (id) => shown.rows(id),
    arrived: (id) => shown.has(id),
    refusal: (id) => refusals.get(id),
    status: () => (send === undefined ? "detached" : pending !== undefined ? "resyncing" : "live"),
    held: () => shown.held(),
    receive: (bytes) => {
      const target = pending?.stream ?? shown;
      const decoded = decodeWindowFrame(bytes);
      if (decoded.isErr()) {
        // a frame that says it is a patch and does not read as one is a patch lost, and it may
        // be the reset an earlier ask was waiting for, so ask again
        asked = undefined;
        resync(target);
        return true;
      }
      const frame = decoded.value;
      if (frame?.kind !== "rows") return frame !== undefined;
      if (target.apply(frame) === "gap") {
        gap(target, frame.epoch);
        return true;
      }
      // every desire sent before the resync was read before it, so its reset holds them all
      const answered = frame.reset && asked !== undefined;
      if (frame.reset) asked = undefined;
      for (const { id } of frame.windows) refusals.delete(id);
      for (const { id, reason } of frame.refused) refusals.set(id, reason);
      if (pending === undefined) notify();
      else {
        const settled = answered
          ? requests.keys()
          : [...frame.windows, ...frame.refused].map((w) => w.id);
        for (const id of settled) pending.settled.add(id);
        settle();
      }
      return true;
    },
    attach: (next) => {
      send = next;
      asked = undefined;
      // a new socket is a new view: rebuild beside the old screen, which stays until then
      pending = { stream: createPatchStream(), settled: new Set() };
      for (const [id, request] of requests) next(desireFrame(id, requestText(request)));
      settle();
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
