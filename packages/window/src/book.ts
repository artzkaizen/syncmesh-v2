import type { CellValue, Row } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { RetryPolicy } from "@syncmesh/temporal";

import { backoff, durationMs } from "@syncmesh/temporal";

import type { RowPut, RowRef, WindowKeys, WindowRefusal, WindowRow } from "./frames.js";
import type { ReadRequest } from "./request.js";
import type { Page, ReadRefused } from "./source.js";

import { readKey } from "./request.js";
import { ReadFailed } from "./source.js";
import { rowId } from "./stream.js";

/** A patch being assembled from one desire, undesire or re-read. */
export interface Draft {
  readonly puts: Map<string, RowPut>;
  readonly dels: Map<string, RowRef>;
  readonly windows: Map<string, WindowKeys>;
  readonly refused: WindowRefusal[];
  readonly failed: Map<string, WindowRefusal>;
  reset: boolean;
}

export const emptyDraft = (): Draft => ({
  puts: new Map(),
  dels: new Map(),
  windows: new Map(),
  refused: [],
  failed: new Map(),
  reset: false,
});

/** Whether a draft carries anything for the client. */
export const isEmpty = (draft: Draft): boolean =>
  draft.puts.size === 0 &&
  draft.dels.size === 0 &&
  draft.windows.size === 0 &&
  draft.refused.length === 0 &&
  draft.failed.size === 0;

interface Open {
  readonly request: ReadRequest;
  /** The request's {@link readKey}: what its rows are held under. */
  readonly read: string;
  readonly keys: readonly string[];
  readonly tables: ReadonlySet<string>;
}

/** A window whose last read failed, and when it is read next. */
interface Failing {
  readonly request: ReadRequest;
  readonly reason: string;
  readonly attempts: number;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface Held {
  readonly read: string;
  readonly key: string;
  row: Row;
  count: number;
}

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

const touches = (window: Open | undefined, tables: ReadonlySet<string>): boolean =>
  window !== undefined && [...window.tables].some((table) => tables.has(table));

/** What a socket's book needs from the server that keeps it. */
export interface WindowBookOptions {
  readonly maxRows: number;
  readonly retry: RetryPolicy;
  /** Why the change feed is down, while it is: a window read then is stale as it lands. */
  readonly feedLost: () => string | undefined;
  /** A failed window's wait is over: read it again. */
  readonly due: (id: string) => void;
}

/**
 * What one socket's windows hold (E27): each window's read and key list, the rows they hold
 * counted by reference, and the windows whose last read failed. Every move writes what the
 * client must be told into a {@link Draft}.
 */
export function createWindowBook({ maxRows, retry, feedLost, due }: WindowBookOptions) {
  const open = new Map<string, Open>();
  const failing = new Map<string, Failing>();
  const held = new Map<string, Held>();

  /**
   * Takes one reference on a row. It is sent when it is new to this socket or its cells changed,
   * so a window that merely re-reads its rows sends nothing for them.
   */
  const take = (draft: Draft, read: string, { key, row }: WindowRow) => {
    const id = rowId(read, key);
    const found = held.get(id);
    const changed = found !== undefined && !sameRow(found.row, row);
    if (found === undefined) held.set(id, { read, key, row, count: 1 });
    else {
      found.count++;
      found.row = row;
    }
    draft.dels.delete(id);
    if (found === undefined || changed) draft.puts.set(id, { read, key, row });
  };

  /** Drops one reference; at zero the row is evicted and the client told. */
  const release = (draft: Draft, read: string, key: string): void => {
    const id = rowId(read, key);
    const found = held.get(id);
    if (found === undefined) return;
    found.count--;
    if (found.count > 0) return;
    held.delete(id);
    draft.puts.delete(id);
    draft.dels.set(id, { read, key });
  };

  /** Forgets that a window failed; `true` when it had. */
  const recover = (id: string): boolean => {
    const before = failing.get(id);
    if (before === undefined) return false;
    clearTimeout(before.timer);
    failing.delete(id);
    return true;
  };

  const unplace = (draft: Draft, id: string): void => {
    recover(id);
    const before = open.get(id);
    if (before === undefined) return;
    open.delete(id);
    for (const key of before.keys) release(draft, before.read, key);
  };

  /** Marks a window failed and, while the feed is up, sets when it is read again. */
  const fail = (draft: Draft, id: string, request: ReadRequest, reason: string): void => {
    const before = failing.get(id);
    clearTimeout(before?.timer);
    const attempts = (before?.attempts ?? 0) + 1;
    // with no feed a fresh read is stale the moment it lands: wait for the feed instead
    const timer =
      feedLost() === undefined
        ? setTimeout(() => due(id), durationMs(backoff(retry, attempts)))
        : undefined;
    failing.set(id, { request, reason, attempts, timer });
    draft.failed.set(id, { id, reason });
  };

  /** Moves the references to match a page, and names the window when its keys moved or `force`. */
  const place = (draft: Draft, id: string, request: ReadRequest, page: Page, force: boolean) => {
    const read = readKey(request);
    const before = open.get(id);
    // take the new references before releasing the old, so a row in both never touches zero
    for (const row of page.rows) take(draft, read, row);
    for (const key of before?.keys ?? []) release(draft, before?.read ?? "", key);
    const keys = page.rows.map((r) => r.key);
    open.set(id, { request, read, keys, tables: page.tables });
    const same =
      before !== undefined &&
      before.read === read &&
      before.keys.length === keys.length &&
      before.keys.every((k, i) => k === keys[i]);
    if (!same || force) draft.windows.set(id, { id, read, keys });
  };

  /** The request a window is read with next: the one that failed, if its newest did. */
  const requestOf = (id: string, window: Open): ReadRequest =>
    failing.get(id)?.request ?? window.request;

  return {
    unplace,
    fail,
    /** Distinct rows held: what the server keeps for this socket. */
    held: () => held.size,
    /** Windows open or waiting to be read again. */
    count: () => open.size + [...failing.keys()].filter((id) => !open.has(id)).length,
    has: (id: string) => open.has(id) || failing.has(id),
    /** Acts on one window's read: its rows, its refusal, or its failure. */
    settle: (
      draft: Draft,
      id: string,
      request: ReadRequest,
      result: Result<Page, ReadRefused | ReadFailed>,
    ): void => {
      if (result.isOk() && result.value.rows.length > maxRows) {
        unplace(draft, id);
        const reason = `${request.path} read ${result.value.rows.length} rows, and a page holds at most ${maxRows}: give it a limit`;
        draft.refused.push({ id, reason });
      } else if (result.isOk()) {
        // a window that had failed is named even when its keys did not move, so the client clears it
        place(draft, id, request, result.value, recover(id));
        const lost = feedLost();
        if (lost !== undefined) fail(draft, id, request, lost);
      } else if (result.error instanceof ReadFailed) fail(draft, id, request, result.error.message);
      else {
        unplace(draft, id);
        draft.refused.push({ id, reason: result.error.message });
      }
    },
    /** Fails every window, each keeping its rows: the feed that would tell it of a change is down. */
    failAll: (draft: Draft, reason: string): void => {
      for (const [id, window] of open) fail(draft, id, requestOf(id, window), reason);
      for (const [id, { request }] of failing) if (!open.has(id)) fail(draft, id, request, reason);
    },
    /** The windows to read again: those a commit touched, those whose wait is over, or all. */
    targets: (tables: ReadonlySet<string>, retried: ReadonlySet<string>, all: boolean) => {
      const out = new Map<string, ReadRequest>();
      for (const [id, window] of open)
        if (all || touches(window, tables)) out.set(id, requestOf(id, window));
      for (const [id, { request }] of failing)
        if (all || retried.has(id) || touches(open.get(id), tables)) out.set(id, request);
      return out;
    },
    /** Everything held, as the reset that resnapshots a client carries it. */
    whole: () => ({
      puts: [...held.values()].map(({ read, key, row }) => ({ read, key, row })),
      windows: [...open].map(([id, w]) => ({ id, read: w.read, keys: w.keys })),
      failed: [...failing].map(([id, f]) => ({ id, reason: f.reason })),
    }),
    /** Stops every wait: a stopped socket reads nothing again. */
    stop: (): void => {
      for (const { timer } of failing.values()) clearTimeout(timer);
    },
  };
}

export type WindowBook = ReturnType<typeof createWindowBook>;
