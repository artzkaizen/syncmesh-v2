import type { Row, RowKey, TableName } from "@syncmesh/kernel";

import { omitUndefined } from "@syncmesh/result";
import { bytesToHex, randomBytes } from "@syncmesh/wire";

import type {
  RowPut,
  RowRef,
  StreamPosition,
  WindowKeys,
  WindowRefusal,
  WindowRow,
} from "./frames.js";
import type { Reader, SortKey, WindowQuery } from "./query.js";
import type { RowChange, RowSource } from "./source.js";

import { decodeWindowFrame, rowsFrame } from "./frames.js";
import { ANONYMOUS, compareSortKeys, matchesWhere, parseQuery, sortKey } from "./query.js";

export interface ClientViewOptions {
  readonly source: RowSource;
  /** Where the encoded `rows` frames go: the socket's queue, never the raw socket (E12). */
  readonly send: (frame: Uint8Array) => void;
  /** Who holds the socket, as the `where` and the read policy see them. */
  readonly reader?: Reader;
  /**
   * The reader's read policy, applied to every row before any `where` (E13: an interest narrows
   * after policy, never instead of it). Absent, the source's rows are all readable.
   */
  readonly admits?: (table: TableName, row: Row) => boolean;
  /** A fresh epoch name. Each reset starts a new epoch, so a stale patch can never land. */
  readonly epoch?: () => string;
  /**
   * Windows one socket may hold at once. A desire for a new id past it is refused, so the view's
   * memory stays at most `maxWindows × limit` keys whatever the client sends.
   * @default 64
   */
  readonly maxWindows?: number;
}

/** The {@link ClientViewOptions.maxWindows} a view takes when none is given. */
export const MAX_WINDOWS = 64;

/**
 * One socket's windows over a row source (E27). A row reaches the client once, however many of
 * this socket's windows hold it, and is evicted when the last of them lets it go. Every change
 * leaves as one versioned patch (E24).
 */
export interface ClientView {
  /** Opens a window, or moves the one under `id`. `since` that is not where this stream stands asks for a reset. */
  readonly desire: (id: string, query: string, since?: StreamPosition) => void;
  readonly undesire: (id: string) => void;
  /**
   * Reads one frame off the socket and acts on a `desire` or `undesire`. Returns `false` for a
   * frame that is not one of those, which the socket's other reader handles.
   */
  readonly receive: (bytes: Uint8Array) => boolean;
  /** Distinct rows this socket's windows hold: the view's memory, bounded by Σ limit. */
  readonly held: () => number;
  /** Stops listening to the source. A closed view reads nothing more and sends nothing more. */
  readonly close: () => void;
}

interface Open {
  readonly query: WindowQuery;
  readonly keys: readonly RowKey[];
  readonly members: ReadonlySet<RowKey>;
  /** The window's last row, or `undefined` when it is empty. */
  readonly last?: SortKey;
}

interface Held {
  readonly table: TableName;
  readonly key: RowKey;
  row: Row;
  count: number;
}

const rowId = (table: TableName, key: RowKey): string => `${table}\u0000${key}`;

const freshEpoch = (): string => bytesToHex(randomBytes(8));

/** A patch being assembled from one desire, undesire or source batch. */
interface Draft {
  readonly puts: Map<string, RowPut>;
  readonly dels: Map<string, RowRef>;
  readonly windows: Map<string, WindowKeys>;
  readonly refused: WindowRefusal[];
  reset: boolean;
}

const emptyDraft = (): Draft => ({
  puts: new Map(),
  dels: new Map(),
  windows: new Map(),
  refused: [],
  reset: false,
});

/**
 * Takes one reference on a row. It is sent when it is new to this socket or when the batch
 * being applied `changed` it, so a window that merely re-reads its rows sends nothing for them.
 */
const take = (
  held: Map<string, Held>,
  draft: Draft,
  table: TableName,
  { key, row }: WindowRow,
  changed: boolean,
): void => {
  const id = rowId(table, key);
  const found = held.get(id);
  if (found === undefined) held.set(id, { table, key, row, count: 1 });
  else {
    found.count++;
    found.row = row;
  }
  draft.dels.delete(id);
  if (found === undefined || changed) draft.puts.set(id, { table, key, row });
};

/** Drops one reference; at zero the row is evicted and the client told. */
const release = (held: Map<string, Held>, draft: Draft, table: TableName, key: RowKey): void => {
  const id = rowId(table, key);
  const found = held.get(id);
  if (found === undefined) return;
  found.count--;
  if (found.count > 0) return;
  held.delete(id);
  draft.puts.delete(id);
  draft.dels.set(id, { table, key });
};

/**
 * Whether one change can move this window. Most cannot, and these checks are cheap: a change
 * to another table; a row that is not held and that the window would not accept; one that
 * sorts before the window's bound or after the last row of a full window.
 */
const touches = (window: Open, change: RowChange, accepts: (row: Row) => boolean): boolean => {
  const { query } = window;
  if (change.table !== query.table) return false;
  if (window.members.has(change.key)) return true;
  if (change.row === undefined || !accepts(change.row)) return false;
  const at = sortKey(query.order, change.key, change.row);
  if (query.after !== undefined && compareSortKeys(query.order, at, query.after) <= 0) return false;
  if (window.keys.length < query.limit || window.last === undefined) return true;
  return compareSortKeys(query.order, at, window.last) < 0;
};

export function createClientView(options: ClientViewOptions): ClientView {
  const {
    source,
    send,
    reader = ANONYMOUS,
    admits,
    epoch: nextEpoch = freshEpoch,
    maxWindows = MAX_WINDOWS,
  } = options;
  const open = new Map<string, Open>();
  const held = new Map<string, Held>();
  let position: StreamPosition | undefined;
  let closed = false;

  const accepts = (query: WindowQuery) => (row: Row) =>
    (admits === undefined || admits(query.table, row)) && matchesWhere(query, row, reader);

  /** Re-reads one window from the source and moves the references to match. */
  const place = (
    draft: Draft,
    id: string,
    query: WindowQuery,
    changed: ReadonlySet<string>,
  ): void => {
    const read = source.window(query, accepts(query));
    if (read.isErr()) {
      unplace(draft, id);
      draft.refused.push({ id, reason: read.error.message });
      return;
    }
    const rows = read.value;
    const before = open.get(id);
    // take the new references before releasing the old, so a row in both never touches zero
    for (const row of rows)
      take(held, draft, query.table, row, changed.has(rowId(query.table, row.key)));
    for (const key of before?.keys ?? [])
      release(held, draft, before?.query.table ?? query.table, key);
    const keys = rows.map((r) => r.key);
    const tail = rows.at(-1);
    open.set(
      id,
      omitUndefined({
        query,
        keys,
        members: new Set(keys),
        last: tail === undefined ? undefined : sortKey(query.order, tail.key, tail.row),
      }),
    );
    const same =
      before !== undefined &&
      before.query.table === query.table &&
      before.keys.length === keys.length &&
      before.keys.every((k, i) => k === keys[i]);
    if (!same) draft.windows.set(id, { id, table: query.table, keys });
  };

  const unplace = (draft: Draft, id: string): void => {
    const before = open.get(id);
    if (before === undefined) return;
    open.delete(id);
    for (const key of before.keys) release(held, draft, before.query.table, key);
  };

  const flush = (draft: Draft): void => {
    if (closed) return;
    const at = position;
    if (draft.reset || at === undefined) {
      position = { epoch: nextEpoch(), version: 1 };
      const patch = {
        ...position,
        reset: true,
        puts: [...held.values()].map(({ table, key, row }) => ({ table, key, row })),
        dels: [],
        windows: [...open].map(([id, w]) => ({ id, table: w.query.table, keys: w.keys })),
        refused: draft.refused,
      };
      send(rowsFrame(patch));
      return;
    }
    if (
      draft.puts.size === 0 &&
      draft.dels.size === 0 &&
      draft.windows.size === 0 &&
      draft.refused.length === 0
    )
      return;
    position = { epoch: at.epoch, version: at.version + 1 };
    send(
      rowsFrame({
        ...position,
        reset: false,
        puts: [...draft.puts.values()],
        dels: [...draft.dels.values()],
        windows: [...draft.windows.values()],
        refused: draft.refused,
      }),
    );
  };

  const onChanges = (changes: readonly RowChange[]): void => {
    const draft = emptyDraft();
    const named = new Set(changes.map((c) => rowId(c.table, c.key)));
    for (const [id, window] of open) {
      const accepted = accepts(window.query);
      if (!changes.some((change) => touches(window, change, accepted))) continue;
      place(draft, id, window.query, named);
    }
    flush(draft);
  };

  const unsubscribe = source.subscribe(onChanges);

  const desire = (id: string, text: string, since?: StreamPosition): void => {
    if (closed) return;
    const draft = emptyDraft();
    const query = parseQuery(text);
    if (query.isErr()) {
      unplace(draft, id);
      draft.refused.push({ id, reason: query.error.message });
    } else if (!open.has(id) && open.size >= maxWindows)
      draft.refused.push({ id, reason: `a socket holds at most ${maxWindows} windows` });
    else place(draft, id, query.value, new Set());
    // a client that names a position this stream is not at missed a patch: resnapshot
    draft.reset =
      since !== undefined &&
      (position === undefined ||
        since.epoch !== position.epoch ||
        since.version !== position.version);
    flush(draft);
  };

  const undesire = (id: string): void => {
    if (closed) return;
    const draft = emptyDraft();
    unplace(draft, id);
    flush(draft);
  };

  return {
    desire,
    undesire,
    receive: (bytes) => {
      const frame = decodeWindowFrame(bytes);
      // a malformed window frame is consumed and changes nothing: there is no window to name
      if (frame.isErr()) return true;
      if (frame.value?.kind === "desire")
        desire(frame.value.id, frame.value.query, frame.value.since);
      else if (frame.value?.kind === "undesire") undesire(frame.value.id);
      return frame.value !== undefined && frame.value.kind !== "rows";
    },
    held: () => held.size,
    close: () => {
      closed = true;
      unsubscribe();
    },
  };
}
