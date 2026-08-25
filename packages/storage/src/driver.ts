/** A value SQLite can bind or return. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** One result row as positional values, in `SELECT` order. */
export type SqlRow = readonly SqlValue[];

/** The calls a SQLite binding must expose; every statement lives above it, so a driver never sees SQL of its own. See RFC-0004. */
export interface SqliteDriver {
  /** Executes a statement for its effect. */
  readonly run: (sql: string, params?: readonly SqlValue[]) => Promise<void>;
  /** Executes a query and returns every row. */
  readonly all: (sql: string, params?: readonly SqlValue[]) => Promise<readonly SqlRow[]>;
  /** Runs `fn` inside one transaction; absent, the store commits one statement at a time. */
  readonly transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly close?: () => Promise<void>;
}
