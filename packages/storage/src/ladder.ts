import type { SqlDriver } from "./driver.js";

/**
 * Walking a schema forward, and refusing to walk one backward.
 *
 * A leaf, like {@link ./namespace.js}: both dialects climb their ladders the same way and only
 * disagree about where the position is written, so the walk lives here once and each dialect
 * brings its own {@link Rung}.
 */

/** Where a ladder remembers how far up it got. */
export interface Rung {
  readonly read: (driver: SqlDriver) => Promise<number>;
  readonly write: (driver: SqlDriver, step: number) => Promise<void>;
}

/**
 * Applies one ladder against the database it belongs to.
 *
 * Writes nothing when the database is already current, and **refuses when it is past the top**.
 * A ladder can only ever write a number it has a rung for, so a larger one was written by a
 * ladder this build does not have: a newer version of this one, or — the case anybody upgrading
 * across RFC-0022 meets — the single-file store that predates the log/state split, whose tables
 * are all in `main` under other names. Both of those read as "current" under a plain `>=`, and
 * the migration is then skipped in silence; the first query for a table that was never created
 * fails a long way from the cause, with `no such table: syncmesh.scope` at a commit.
 */
export const ladder = async (
  driver: SqlDriver,
  at: Rung,
  steps: readonly (readonly string[])[],
): Promise<void> => {
  const applied = await at.read(driver);
  if (applied > steps.length) {
    throw new Error(
      `this database is at step ${applied} of a schema that has ${steps.length}, so it was written by a build this one does not have and nothing here can read it safely. Open it with the build that wrote it, or move it aside and let this one rebuild.`,
    );
  }
  // nothing to apply is nothing to write: a launch that migrated nothing should touch no page
  if (applied === steps.length) return;
  for (const step of steps.slice(applied)) {
    for (const sql of step) await driver.run(sql)
  }
  await at.write(driver, steps.length);
};
