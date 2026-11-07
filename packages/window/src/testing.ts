import type { JsonValue, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { WindowRow } from "./frames.js";
import type { PageSource } from "./source.js";

import { ReadRefused } from "./source.js";

/** One read a memory source serves: the table it reads, and how a page is cut from its rows. */
export interface MemoryRead {
  readonly table: string;
  /** The page, from every row of the table the reader may read, in no particular order. */
  readonly page: (rows: readonly WindowRow[], input: JsonValue) => readonly WindowRow[];
}

/** A row that now holds this value, or (`row` absent) a row that is gone. */
export interface MemoryChange {
  readonly key: string;
  readonly row?: Row;
}

/**
 * A {@link PageSource} over maps, for tests of the window protocol. It reads every row on every
 * page, so it says nothing about what a read costs; that is the Postgres source's test.
 */
export interface MemoryPageSource extends PageSource {
  /** Applies one transaction to a table and tells every listener once. */
  readonly write: (table: string, changes: readonly MemoryChange[]) => void;
  /** Fills a table without telling anyone, as a database has rows before any window opens. */
  readonly load: (table: string, rows: Iterable<WindowRow>) => void;
  /** How many pages have been read, which is how a test sees a re-read that should not happen. */
  readonly pagesRead: () => number;
}

export interface MemoryPageSourceOptions {
  /**
   * The reader's read permission, applied to every row before the read sees it, as the Postgres
   * source applies the read rule before the handler's `where` (E13). Absent, every row is readable.
   */
  readonly canRead?: (table: string, row: Row) => boolean;
}

export function createMemoryPageSource(
  reads: Readonly<Record<string, MemoryRead>>,
  options: MemoryPageSourceOptions = {},
): MemoryPageSource {
  const { canRead = () => true } = options;
  const tables = new Map<string, Map<string, Row>>();
  const listeners = new Set<(tables: ReadonlySet<string>) => void>();
  let pagesRead = 0;

  const tableRows = (table: string): Map<string, Row> => {
    const rows = tables.get(table) ?? new Map<string, Row>();
    tables.set(table, rows);
    return rows;
  };

  return {
    readPage: async ({ path, input }) => {
      const read = reads[path];
      if (read === undefined) return Result.err(new ReadRefused({ message: `no read ${path}` }));
      pagesRead++;
      const readable = [...tableRows(read.table)]
        .filter(([, row]) => canRead(read.table, row))
        .map(([key, row]) => ({ key, row }));
      return Result.ok({ rows: read.page(readable, input), tables: new Set([read.table]) });
    },
    onCommit: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (table, changes) => {
      const rows = tableRows(table);
      for (const { key, row } of changes)
        if (row === undefined) rows.delete(key);
        else rows.set(key, row);
      for (const listener of listeners) listener(new Set([table]));
    },
    load: (table, rows) => {
      const held = tableRows(table);
      for (const { key, row } of rows) held.set(key, row);
    },
    pagesRead: () => pagesRead,
  };
}
