import type { Unsubscribe } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal, durationMs } from "@syncmesh/temporal";

/**
 * Local-only data with no replication promise (book ch. 8): the half-typed note a screen keeps
 * while the user decides, the form a refused write left behind.
 *
 * Deliberately **not** a synced table. A draft is one device's business — replicating it would
 * mean merging two half-finished sentences, which is the one thing the lattice cannot make
 * sensible — and deliberately not the outbox either: a draft is not a write anyone promised.
 */
export interface DraftSaveOptions {
  /** How long this value lives. Absent, it lives until forgotten. Checked lazily on read. */
  readonly ttl?: Temporal.Duration;
}

export interface Drafts {
  readonly save: (
    key: string,
    value: string,
    options?: DraftSaveOptions,
  ) => Promise<ResultType<void, StoreFailure>>;
  /** Expired rows read as absent — and are gone when a later sweep looks. */
  readonly get: (key: string) => Promise<ResultType<string | undefined, StoreFailure>>;
  readonly forget: (key: string) => Promise<ResultType<void, StoreFailure>>;
  /** Fires with the key on every save and forget. Expiry is observed on read, not pushed. */
  readonly onChange: (listener: (key: string) => void) => Unsubscribe;
  /** Deletes every expired row. Returns how many went. */
  readonly sweep: () => Promise<ResultType<number, StoreFailure>>;
}

const TABLE = "syncmesh_drafts";

export const draftsDdl = `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`;

export interface DraftStoreOptions {
  /** The clock expiry is measured against. Default the wall clock. */
  readonly now?: () => Temporal.Instant;
}

export function createDrafts(driver: SqlDriver, options: DraftStoreOptions = {}): Drafts {
  const now = options.now ?? (() => Temporal.Now.instant());
  const mark = (n: number): string => (driver.dialect === "postgres" ? `$${String(n)}` : "?");
  const listeners = new Set<(key: string) => void>();
  const emit = (key: string): void => {
    for (const listener of [...listeners]) listener(key);
  };
  const opened = (async (): Promise<void> => {
    await driver.run(draftsDdl);
    // tables created before expiry existed have no expires_at: add it, and swallow
    // the duplicate-column refusal on tables that already do. The column is only
    // ever appended to, never backfilled — an old row without one simply never expires.
    await Result.tryPromise({
      try: () =>
        driver.run(
          driver.dialect === "postgres"
            ? `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS expires_at INTEGER`
            : `ALTER TABLE ${TABLE} ADD COLUMN expires_at INTEGER`,
        ),
      catch: () => undefined,
    });
  })().then(
    () => undefined,
    () => undefined,
  );
  const attempt = <T>(message: string, fn: () => Promise<T>) =>
    Result.tryPromise({
      try: async () => {
        await opened;
        return fn();
      },
      catch: (cause) => new StoreFailure({ message, cause }),
    });

  /** An expiry timestamp, or null for immortal. Days and weeks count in exact milliseconds. */
  const expiresAt = (ttl: Temporal.Duration | undefined): number | null =>
    ttl === undefined ? null : now().epochMilliseconds + durationMs(ttl);

  return {
    save: (key, value, saveOptions) =>
      attempt("draft save failed", async () => {
        await driver.run(
          `INSERT INTO ${TABLE} (key, value, expires_at) VALUES (${mark(1)}, ${mark(2)}, ${mark(3)})
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
          [key, value, expiresAt(saveOptions?.ttl)],
        );
        emit(key);
      }),
    get: (key) =>
      attempt("draft read failed", async () => {
        const rows = await driver.all(
          `SELECT value, expires_at FROM ${TABLE} WHERE key = ${mark(1)}`,
          [key],
        );
        const held = rows[0];
        if (held === undefined) return undefined;
        const expires = held[1];
        if (typeof expires === "number" && expires <= now().epochMilliseconds) {
          await driver.run(`DELETE FROM ${TABLE} WHERE key = ${mark(1)}`, [key]);
          return undefined;
        }
        const value = held[0];
        return value === null || value === undefined ? undefined : String(value);
      }),
    forget: (key) =>
      attempt("draft forget failed", async () => {
        await driver.run(`DELETE FROM ${TABLE} WHERE key = ${mark(1)}`, [key]);
        emit(key);
      }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    sweep: () =>
      attempt("draft sweep failed", async () => {
        const removed = await driver
          .all(
            `DELETE FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at <= ${mark(1)} RETURNING key`,
            [now().epochMilliseconds],
          )
          .catch(() => undefined);
        // RETURNING is absent on older SQLite builds: fall back to select-then-delete.
        if (removed !== undefined) return removed.length;
        const due = await driver.all(
          `SELECT key FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at <= ${mark(1)}`,
          [now().epochMilliseconds],
        );
        for (const row of due) {
          const key = row[0];
          await driver.run(`DELETE FROM ${TABLE} WHERE key = ${mark(1)}`, [
            typeof key === "string" ? key : String(key),
          ]);
        }
        return due.length;
      }),
  };
}
