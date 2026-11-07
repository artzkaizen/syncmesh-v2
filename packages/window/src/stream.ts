import type { RowKey, TableName } from "@syncmesh/kernel";

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
  /**
   * One window's rows in its order; empty for a window this stream has not been sent. The same
   * array comes back until a patch lands or the window is forgotten, so it can be a snapshot.
   */
  readonly rows: (id: string) => readonly WindowRow[];
  /** The last patch applied, or `undefined` before the first reset. */
  readonly position: () => StreamPosition | undefined;
  /** How many distinct rows are held across every window, which is what bounds its memory. */
  readonly held: () => number;
  /**
   * Forgets one window and keeps its rows. While the server has not read the undesire it still
   * counts them as held, and may name one in another window without sending it again; its
   * `del`s for them come in the patch that answers the undesire.
   */
  readonly forget: (id: string) => void;
  /**
   * Drops every row no window names. Only for a stream no server is patching: one that is,
   * may still name them in a patch on the socket.
   */
  readonly prune: () => void;
}

const rowId = (table: TableName, key: RowKey): string => `${table}\u0000${key}`;

/** What {@link PatchStream.rows} returns for a window it does not hold: one array, never a new one. */
const NO_ROWS = [] as const satisfies readonly WindowRow[];

export function createPatchStream(): PatchStream {
  const rows = new Map<string, WindowRow>();
  const windows = new Map<string, WindowKeys>();
  /** Each window's rows as {@link PatchStream.rows} last built them, until something changes. */
  const rendered = new Map<string, readonly WindowRow[]>();
  let position: StreamPosition | undefined;

  const next = (patch: RowPatch): boolean =>
    patch.reset ||
    (position !== undefined &&
      patch.epoch === position.epoch &&
      patch.version === position.version + 1);

  return {
    apply: (patch) => {
      if (!next(patch)) return "gap";
      rendered.clear();
      if (patch.reset) {
        rows.clear();
        windows.clear();
      }
      for (const put of patch.puts) rows.set(rowId(put.table, put.key), put);
      for (const del of patch.dels) rows.delete(rowId(del.table, del.key));
      for (const window of patch.windows) windows.set(window.id, window);
      for (const refusal of patch.refused) windows.delete(refusal.id);
      position = { epoch: patch.epoch, version: patch.version };
      return "applied";
    },
    rows: (id) => {
      const cached = rendered.get(id);
      if (cached !== undefined) return cached;
      const window = windows.get(id);
      if (window === undefined) return NO_ROWS;
      const out: WindowRow[] = [];
      for (const key of window.keys) {
        const held = rows.get(rowId(window.table, key));
        if (held !== undefined) out.push({ key: held.key, row: held.row });
      }
      rendered.set(id, out);
      return out;
    },
    position: () => position,
    held: () => rows.size,
    forget: (id) => {
      windows.delete(id);
      rendered.delete(id);
    },
    prune: () => {
      const kept = new Set<string>();
      for (const window of windows.values())
        for (const key of window.keys) kept.add(rowId(window.table, key));
      for (const id of rows.keys()) if (!kept.has(id)) rows.delete(id);
    },
  };
}
