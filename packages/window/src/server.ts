import type { CellValue, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { bytesToHex, randomBytes } from "@syncmesh/wire";

import type {
  RowPut,
  RowRef,
  StreamPosition,
  WindowKeys,
  WindowRefusal,
  WindowRow,
} from "./frames.js";
import type { ReadRequest } from "./request.js";
import type { Page, PageSource } from "./source.js";

import { decodeWindowFrame, rowsFrame } from "./frames.js";
import { parseRequest } from "./request.js";
import { ReadRefused } from "./source.js";
import { rowId } from "./stream.js";

export interface ServerWindowsOptions {
  /** Runs each window's read, already scoped to the reader this socket belongs to. */
  readonly source: PageSource;
  /** Where the encoded `rows` frames go: the socket's queue, never the raw socket (E12). */
  readonly send: (frame: Uint8Array) => void;
  /** A fresh epoch name. Each reset starts a new epoch, so a stale patch can never land. */
  readonly epoch?: () => string;
  /**
   * Windows one socket may hold at once. A desire for a new id past it is refused, so what the
   * server holds stays at most `maxWindows` pages whatever the client sends.
   * @default 64
   */
  readonly maxWindows?: number;
}

/** The {@link ServerWindowsOptions.maxWindows} a socket takes when none is given. */
export const MAX_WINDOWS = 64;

/**
 * The server's half of one socket's windows (E27). A row reaches the client once, however many
 * of this socket's windows hold it, and is evicted when the last of them lets it go. Every change
 * leaves as one versioned patch (E24).
 *
 * Work runs one step at a time in arrival order — a desire, an undesire, a commit — so a patch
 * always describes the step before it, whatever each read costs.
 */
export interface ServerWindows {
  /**
   * Reads one frame off the socket and acts on a `desire` or `undesire`. Returns `false` for a
   * frame that is not one of those, which the socket's other reader handles.
   */
  readonly receive: (bytes: Uint8Array) => boolean;
  /** Distinct rows this socket's windows hold: what the server keeps for it. */
  readonly held: () => number;
  /** Resolves once every frame received and every commit seen so far has been answered. */
  readonly idle: () => Promise<void>;
  /** Stops listening for commits. A stopped socket reads nothing more and sends nothing more. */
  readonly stop: () => void;
}

interface Open {
  readonly request: ReadRequest;
  readonly keys: readonly string[];
  readonly tables: ReadonlySet<string>;
}

interface Held {
  readonly path: string;
  readonly key: string;
  row: Row;
  count: number;
}

const freshEpoch = (): string => bytesToHex(randomBytes(8));

/** A patch being assembled from one desire, undesire or commit. */
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

/* oxlint-disable anti-slop/no-runtime-typeof -- comparing cells dispatches on a cell's runtime kind */
const sameCell = (a: CellValue | undefined, b: CellValue | undefined): boolean => {
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  if (typeof a === "object" && a !== null) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
};
/* oxlint-enable anti-slop/no-runtime-typeof */

const sameRow = (a: Row, b: Row): boolean =>
  a.size === b.size && [...a].every(([column, cell]) => sameCell(cell, b.get(column)));

/**
 * Takes one reference on a row. It is sent when it is new to this socket or its cells changed,
 * so a window that merely re-reads its rows sends nothing for them.
 */
const take = (held: Map<string, Held>, draft: Draft, path: string, { key, row }: WindowRow) => {
  const id = rowId(path, key);
  const found = held.get(id);
  const changed = found !== undefined && !sameRow(found.row, row);
  if (found === undefined) held.set(id, { path, key, row, count: 1 });
  else {
    found.count++;
    found.row = row;
  }
  draft.dels.delete(id);
  if (found === undefined || changed) draft.puts.set(id, { path, key, row });
};

/** Drops one reference; at zero the row is evicted and the client told. */
const release = (held: Map<string, Held>, draft: Draft, path: string, key: string): void => {
  const id = rowId(path, key);
  const found = held.get(id);
  if (found === undefined) return;
  found.count--;
  if (found.count > 0) return;
  held.delete(id);
  draft.puts.delete(id);
  draft.dels.set(id, { path, key });
};

const touches = (window: Open, tables: ReadonlySet<string>): boolean =>
  [...window.tables].some((table) => tables.has(table));

export function createServerWindows(options: ServerWindowsOptions): ServerWindows {
  const { source, send, epoch: nextEpoch = freshEpoch, maxWindows = MAX_WINDOWS } = options;
  const open = new Map<string, Open>();
  const held = new Map<string, Held>();
  let position: StreamPosition | undefined;
  let stopped = false;
  let tail = Promise.resolve();
  /** Tables committed since the last re-read began; one re-read answers every commit queued behind it. */
  const dirty = new Set<string>();
  let rereading = false;

  /** Runs `step` after every step before it. A step never throws: a read that does is a refusal. */
  const queue = (step: () => Promise<void>): void => {
    tail = tail.then(step);
  };

  const readPage = async (request: ReadRequest): Promise<Result<Page, ReadRefused>> =>
    (
      await Result.tryPromise({
        try: () => source.readPage(request),
        catch: (cause) =>
          new ReadRefused({ message: cause instanceof Error ? cause.message : "the read failed" }),
      })
    ).andThen((page) => page);

  const unplace = (draft: Draft, id: string): void => {
    const before = open.get(id);
    if (before === undefined) return;
    open.delete(id);
    for (const key of before.keys) release(held, draft, before.request.path, key);
  };

  /** Runs one window's read and moves the references to match. */
  const place = async (draft: Draft, id: string, request: ReadRequest): Promise<void> => {
    const read = await readPage(request);
    if (read.isErr()) {
      unplace(draft, id);
      draft.refused.push({ id, reason: read.error.message });
      return;
    }
    const { rows, tables } = read.value;
    const before = open.get(id);
    // take the new references before releasing the old, so a row in both never touches zero
    for (const row of rows) take(held, draft, request.path, row);
    for (const key of before?.keys ?? []) release(held, draft, before?.request.path ?? "", key);
    const keys = rows.map((r) => r.key);
    open.set(id, { request, keys, tables });
    const same =
      before !== undefined &&
      before.request.path === request.path &&
      before.keys.length === keys.length &&
      before.keys.every((k, i) => k === keys[i]);
    if (!same) draft.windows.set(id, { id, path: request.path, keys });
  };

  const flush = (draft: Draft): void => {
    if (stopped) return;
    const at = position;
    if (draft.reset || at === undefined) {
      position = { epoch: nextEpoch(), version: 1 };
      send(
        rowsFrame({
          ...position,
          reset: true,
          puts: [...held.values()].map(({ path, key, row }) => ({ path, key, row })),
          dels: [],
          windows: [...open].map(([id, w]) => ({ id, path: w.request.path, keys: w.keys })),
          refused: draft.refused,
        }),
      );
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

  const reread = async (): Promise<void> => {
    rereading = false;
    const tables = new Set(dirty);
    dirty.clear();
    if (stopped) return;
    const touched = [...open].filter(([, window]) => touches(window, tables));
    // a commit that touches no open window sends nothing, so an idle socket is sent nothing
    if (touched.length === 0) return;
    const draft = emptyDraft();
    for (const [id, window] of touched) await place(draft, id, window.request);
    flush(draft);
  };

  const unsubscribe = source.onCommit((tables) => {
    // queued even with no window open: a desire whose read is in flight may have read before
    // this commit, and the re-read behind it is what catches that
    for (const table of tables) dirty.add(table);
    if (rereading || stopped) return;
    rereading = true;
    queue(reread);
  });

  const desire = async (id: string, text: string, since?: StreamPosition): Promise<void> => {
    if (stopped) return;
    const draft = emptyDraft();
    const request = parseRequest(text);
    if (request.isErr()) {
      unplace(draft, id);
      draft.refused.push({ id, reason: request.error.message });
    } else if (!open.has(id) && open.size >= maxWindows)
      draft.refused.push({ id, reason: `a socket holds at most ${maxWindows} windows` });
    else await place(draft, id, request.value);
    // a client that names a position this stream is not at missed a patch: resnapshot
    draft.reset =
      since !== undefined &&
      (position === undefined ||
        since.epoch !== position.epoch ||
        since.version !== position.version);
    flush(draft);
  };

  const undesire = async (id: string): Promise<void> => {
    if (stopped) return;
    const draft = emptyDraft();
    unplace(draft, id);
    flush(draft);
  };

  return {
    receive: (bytes) => {
      const frame = decodeWindowFrame(bytes);
      // a malformed window frame is consumed and changes nothing: there is no window to name
      if (frame.isErr()) return true;
      const { value } = frame;
      if (value?.kind === "desire") queue(() => desire(value.id, value.request, value.since));
      else if (value?.kind === "undesire") queue(() => undesire(value.id));
      return value !== undefined && value.kind !== "rows";
    },
    held: () => held.size,
    idle: async () => {
      // a step can queue another (a commit seen mid-read), so wait until the tail stops moving
      let seen: Promise<void> | undefined;
      while (seen !== tail) {
        seen = tail;
        await seen;
      }
    },
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}
