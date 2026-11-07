import type { ServerWindows, ServerWindowsOptions } from "@syncmesh/window";

import { createServerWindows, decodeWindowFrame } from "@syncmesh/window";

import type { RelaySocket } from "./sender.js";

import { DEFAULT_LIMITS } from "./limits.js";
import { createSender } from "./sender.js";

/**
 * What a host hands {@link serveWindows}: the page source for this socket's reader, and the
 * socket's ceilings. The source is built for the principal the host authenticated, so what it
 * reads is already what that reader may see.
 */
export interface WindowServerOptions extends Omit<ServerWindowsOptions, "send"> {
  /** Frames queued before the socket is closed as one that cannot keep up. */
  readonly maxBacklog?: number;
  /** Bytes queued before the same; a screen of large rows is bytes before it is frames. */
  readonly maxBacklogBytes?: number;
}

/** One socket's windows, as the host drives them. */
export interface WindowConnection {
  /**
   * A frame off the socket. `false` when it is not a window frame, for the host's other reader.
   * A window frame on a socket already closed is consumed and changes nothing.
   */
  readonly receive: (bytes: Uint8Array) => boolean;
  /** The socket drained: flush queued patches in order. */
  readonly drain: () => void;
  /**
   * The socket is gone: the windows stop listening and send nothing more. A socket the sender
   * closed at its backlog ceiling has already stopped its windows.
   */
  readonly close: () => void;
  readonly windows: ServerWindows;
  readonly backlog: () => number;
}

/**
 * Serves `desire / undesire / rows` on one socket from a server that holds the rows (D43). A
 * relay room holds a log and no rows, so it does not call this. A host beside a database does.
 *
 * Every patch goes through E12's sender, never raw to the socket. A full buffer queues the
 * patch, and a queue past its ceiling closes the socket rather than dropping a patch from the
 * middle. The client reconnects and the new socket resnapshots it, so the failure costs one
 * screen, and a wrong screen never results (E24).
 */
export function serveWindows(socket: RelaySocket, options: WindowServerOptions): WindowConnection {
  const {
    maxBacklog = 1000,
    maxBacklogBytes = DEFAULT_LIMITS.maxBacklogBytes,
    ...serving
  } = options;
  const sender = createSender(socket, maxBacklog, maxBacklogBytes);
  const windows = createServerWindows({
    ...serving,
    // a socket closed at the backlog ceiling is gone: stop re-reading windows for it
    send: (frame) => {
      sender.send(frame);
      if (!sender.alive()) windows.stop();
    },
  });
  return {
    receive: (bytes) =>
      sender.alive()
        ? windows.receive(bytes)
        : decodeWindowFrame(bytes).match({ ok: (frame) => frame !== undefined, err: () => true }),
    drain: sender.drain,
    close: windows.stop,
    windows,
    backlog: sender.backlog,
  };
}
