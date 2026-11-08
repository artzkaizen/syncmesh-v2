import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";
import type { Table } from "@syncmesh/schema";

import { parseTableName } from "@syncmesh/schema";

import type { SqlDriver } from "./driver.js";

import { driverDialect } from "./dialect.js";
import { attempt } from "./sql.js";

/**
 * Whether a write to a synced table made outside a captured transaction is refused (gaps U5).
 *
 * `true`, the default: a guard trigger raises on it, because the row would change and no event
 * would carry the change — the device diverges from every peer and nothing says so. `false` lets
 * such writes through, as before. `{ except }` guards every table but the ones named: a table an
 * external writer owns, whose changes reach the mesh some other way (CDC, a sweeper).
 *
 * Only the fold's own writes pass the guard (`CaptureSql.fold`). A role that sets the capture
 * setting itself can get past it: this guards against mistakes, not against a hostile writer
 * holding the same connection.
 */
export type StrictCapture = boolean | { readonly except: readonly string[] };

/** The tables a {@link StrictCapture} setting guards. */
export const strictGuards =
  (strict: StrictCapture = true) =>
  (table: Table): boolean =>
    strict === true || strict === false ? strict : !strict.except.includes(table.name);

/** Exactly what the strict guard's install runs for these tables, in order. */
export const guardStatements = (
  driver: Pick<SqlDriver, "dialect">,
  tables: readonly Table[],
  strict?: StrictCapture,
): readonly string[] => driverDialect(driver).capture.guardDdl(tables, strictGuards(strict));

/**
 * Runs the guard's install for these tables, then drops it from every table that carries one and
 * is not among them: a table the schema no longer has, which no setting could otherwise reach.
 * Throws what the driver throws.
 */
export async function applyGuard(
  driver: SqlDriver,
  tables: readonly Table[],
  strict?: StrictCapture,
): Promise<void> {
  const { capture } = driverDialect(driver);
  for (const sql of guardStatements(driver, tables, strict)) await driver.run(sql);
  const named = new Set(tables.map((table) => table.name));
  for (const [cell] of await driver.all(capture.guardedTables)) {
    // a name that does not parse is no table the guard was ever installed on
    const name = parseTableName(String(cell));
    if (name.isErr() || named.has(name.value)) continue;
    for (const sql of capture.unguardDdl(name.value)) await driver.run(sql);
  }
}

/**
 * Installs or drops the strict-capture guard on these tables ({@link StrictCapture}), and drops it
 * from any table outside them that still carries one.
 */
export function installGuard(
  driver: SqlDriver,
  tables: readonly Table[],
  strict?: StrictCapture,
): Promise<Result<void, StoreFailure>> {
  return attempt("could not install the strict-capture guard", () =>
    applyGuard(driver, tables, strict),
  );
}

/**
 * Runs `fn` — the fold's own writes into the app's tables — past the strict guard, inside the
 * caller's transaction. The guard is back at rest after it, thrown or not.
 */
export async function folding<T>(driver: SqlDriver, fn: () => Promise<T>): Promise<T> {
  const { capture } = driverDialect(driver);
  await driver.run(capture.fold);
  try {
    return await fn();
  } finally {
    await driver.run(capture.unfold);
  }
}
