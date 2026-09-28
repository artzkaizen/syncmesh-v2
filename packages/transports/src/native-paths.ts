import type { Path } from "./native-stream.js";

import { pathOver } from "./native-stream.js";

/**
 * What the shared path lifecycle needs of a native module: ending a path on the
 * platform, letting held bytes through, and taking a write. Both React Native
 * bindings (`lan/rn-lan.ts`, `p2p/rn-p2p.ts`) satisfy this structurally — the rest
 * of their managers (announcements, pairing, listeners) stays medium-specific.
 */
export interface NativePathHost {
  readonly closePath: (handle: string) => void;
  readonly resume: (handle: string) => void;
  readonly send: (handle: string, bytes: Uint8Array) => Promise<void>;
}

/** Bytes about a path this side has not built yet: chunks in arrival order, plus the close. */
export interface EarlyBuffer {
  readonly chunks: Uint8Array[];
  closed: boolean;
}

export interface NativePaths {
  /** Builds (or rebuilds) the path, flushing whatever arrived early, in order. */
  readonly open: (handle: string) => Path;
  readonly get: (handle: string) => Path | undefined;
  readonly has: (handle: string) => boolean;
  /**
   * Holds bytes for a path that does not exist yet — or nothing, when no dial is
   * out (unsolicited early bytes are noise, not state) or the buffer is full.
   */
  readonly early: (handle: string) => EarlyBuffer | undefined;
  readonly forget: (handle: string) => void;
  /** Ends the path here and tells the platform too. */
  readonly release: (handle: string) => void;
  /** A dial started/settled. When none is outstanding, nothing may go on holding early bytes. */
  readonly beginDial: () => void;
  readonly endDial: () => void;
  /** Ends every path at the platform and drops all early bytes: close and dispose share it. */
  readonly reset: () => void;
}

/**
 * One device's paths over a native module, shared by the LAN and P2P bindings.
 *
 * A handle the platform reused — or reported twice — names a dead object either way:
 * the old path is forgotten before the new one is built, so new bytes never route
 * into a stream nobody is reading. A chunk that landed before its path existed is
 * older than any after it, so early bytes flush in arrival order on open.
 */
export function createNativePaths(host: NativePathHost, earlyPaths = 8): NativePaths {
  const paths = new Map<string, Path>();
  const early = new Map<string, EarlyBuffer>();
  let dialling = 0;

  const earlyFor = (handle: string): EarlyBuffer | undefined => {
    if (dialling === 0 || early.size >= earlyPaths) return undefined;
    const holding = early.get(handle) ?? { chunks: [], closed: false };
    early.set(handle, holding);
    return holding;
  };

  const forget = (handle: string): void => {
    const path = paths.get(handle);
    if (path === undefined) return;
    paths.delete(handle);
    path.shut();
  };

  const release = (handle: string): void => {
    host.closePath(handle);
    forget(handle);
  };

  const open = (handle: string): Path => {
    forget(handle);
    const path = pathOver(handle, {
      close: () => release(handle),
      resume: () => host.resume(handle),
      send: (bytes) => host.send(handle, bytes),
    });
    paths.set(handle, path);
    const waiting = early.get(handle);
    if (waiting === undefined) return path;
    early.delete(handle);
    for (const chunk of waiting.chunks) path.accept(chunk);
    if (waiting.closed) forget(handle);
    return path;
  };

  return {
    open,
    get: (handle) => paths.get(handle),
    has: (handle) => paths.has(handle),
    early: earlyFor,
    forget,
    release,
    beginDial: () => {
      dialling += 1;
    },
    endDial: () => {
      dialling -= 1;
      if (dialling === 0) early.clear();
    },
    reset: () => {
      // deleted from under the iterator by `release`, which a Map allows
      for (const handle of paths.keys()) release(handle);
      early.clear();
    },
  };
}
