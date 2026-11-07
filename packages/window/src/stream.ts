import type { RowPatch, StreamPosition, WindowKeys, WindowRow } from "./frames.js";

/** What applying one patch did: it landed, or it was not the next one and nothing changed. */
export type Applied = "applied" | "gap";

/**
 * The rows a store-less client holds, kept only from versioned patches (E24). It folds nothing
 * and checks no signature: it holds what the server's view sent, in the order the server put
 * each window in.
 */
export interface PatchStream {
  /**
   * Applies a patch if it is the next one: a reset, or `version + 1` in the epoch already held.
   * Anything else is a `gap` and leaves the rows as they were. The caller then asks for a
   * resnapshot, because a patch that went missing cannot be rebuilt from the ones around it.
   */
  readonly apply: (patch: RowPatch) => Applied;
  /** One window's rows in its order; empty for a window this stream has not been sent. */
  readonly rows: (id: string) => readonly WindowRow[];
  /** Whether this stream has been sent the window's key list, which an empty page also is. */
  readonly has: (id: string) => boolean;
  /** The last patch applied, or `undefined` before the first reset. */
  readonly position: () => StreamPosition | undefined;
  /** How many distinct rows are held across every window, which is what bounds its memory. */
  readonly held: () => number;
  /** Forgets one window's key list; its rows go when the server's `del` says so. */
  readonly forget: (id: string) => void;
}

/** One read's row: the same key under two reads is two rows, since each may project it differently. */
export const rowId = (path: string, key: string): string => `${path}\u0000${key}`;

export function createPatchStream(): PatchStream {
  const rows = new Map<string, WindowRow>();
  const windows = new Map<string, WindowKeys>();
  let position: StreamPosition | undefined;

  const next = (patch: RowPatch): boolean =>
    patch.reset ||
    (position !== undefined &&
      patch.epoch === position.epoch &&
      patch.version === position.version + 1);

  return {
    apply: (patch) => {
      if (!next(patch)) return "gap";
      if (patch.reset) {
        rows.clear();
        windows.clear();
      }
      for (const put of patch.puts) rows.set(rowId(put.path, put.key), put);
      for (const del of patch.dels) rows.delete(rowId(del.path, del.key));
      for (const window of patch.windows) windows.set(window.id, window);
      for (const refusal of patch.refused) windows.delete(refusal.id);
      position = { epoch: patch.epoch, version: patch.version };
      return "applied";
    },
    rows: (id) => {
      const window = windows.get(id);
      if (window === undefined) return [];
      const out: WindowRow[] = [];
      for (const key of window.keys) {
        const held = rows.get(rowId(window.path, key));
        if (held !== undefined) out.push({ key: held.key, row: held.row });
      }
      return out;
    },
    has: (id) => windows.has(id),
    position: () => position,
    held: () => rows.size,
    forget: (id) => {
      windows.delete(id);
    },
  };
}
