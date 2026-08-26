/** A value a SQL binding can take or return; booleans and dates only where the dialect has them. */
export type SqlValue = string | number | bigint | boolean | Uint8Array | Date | null;

/** One result row as positional values, in `SELECT` order. */
export type SqlRow = readonly SqlValue[];

export type SqlDialect = "sqlite" | "postgres";

/**
 * The calls a database binding must expose; every statement lives above it, so a driver never
 * sees SQL of its own. The dialect picks which statements — each store owns one set per dialect,
 * never one string that pretends to be both. See RFC-0004.
 */
export interface SqlDriver {
  /** Absent reads as `sqlite` — the on-device default. */
  readonly dialect?: SqlDialect;
  /** Executes a statement for its effect. */
  readonly run: (sql: string, params?: readonly SqlValue[]) => Promise<void>;
  /** Executes a query and returns every row. */
  readonly all: (sql: string, params?: readonly SqlValue[]) => Promise<readonly SqlRow[]>;
  /** Runs `fn` inside one transaction; absent, the store commits one statement at a time. */
  readonly transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly close?: () => Promise<void>;
}

/** A driver over SQLite: the device's database, where capture and the app's tables also live. */
export type SqliteDriver = SqlDriver & { readonly dialect?: "sqlite" };

/** A driver over Postgres: the app's own database on the server, log and state alongside its tables. */
export type PostgresDriver = SqlDriver & { readonly dialect: "postgres" };
