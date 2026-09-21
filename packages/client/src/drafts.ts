import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";

import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

/**
 * Local-only data with no replication promise (book ch. 8): the half-typed note a screen keeps
 * while the user decides, the form a refused write left behind.
 *
 * Deliberately **not** a synced table. A draft is one device's business — replicating it would
 * mean merging two half-finished sentences, which is the one thing the lattice cannot make
 * sensible — and deliberately not the outbox either: a draft is not a write anyone promised.
 */
export interface Drafts {
  readonly save: (key: string, value: string) => Promise<ResultType<void, StoreFailure>>;
  readonly get: (key: string) => Promise<ResultType<string | undefined, StoreFailure>>;
  readonly forget: (key: string) => Promise<ResultType<void, StoreFailure>>;
}

const TABLE = "syncmesh_drafts";

export const draftsDdl = `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

export function createDrafts(driver: SqlDriver): Drafts {
  const mark = (n: number): string => (driver.dialect === "postgres" ? `$${String(n)}` : "?");
  const opened = driver
    .run(draftsDdl)
    .then(() => undefined)
    .catch(() => undefined);
  const attempt = <T>(message: string, fn: () => Promise<T>) =>
    Result.tryPromise({
      try: async () => {
        await opened;
        return fn();
      },
      catch: (cause) => new StoreFailure({ message, cause }),
    });

  return {
    save: (key, value) =>
      attempt("draft save failed", () =>
        driver.run(
          `INSERT INTO ${TABLE} (key, value) VALUES (${mark(1)}, ${mark(2)})
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, value],
        ),
      ),
    get: (key) =>
      attempt("draft read failed", async () => {
        const rows = await driver.all(`SELECT value FROM ${TABLE} WHERE key = ${mark(1)}`, [key]);
        const held = rows[0]?.[0];
        return held === null || held === undefined ? undefined : String(held);
      }),
    forget: (key) =>
      attempt("draft forget failed", () =>
        driver.run(`DELETE FROM ${TABLE} WHERE key = ${mark(1)}`, [key]),
      ),
  };
}
