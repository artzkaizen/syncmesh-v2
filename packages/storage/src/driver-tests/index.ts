import type { SuiteCase } from "@syncmesh/engine";

import type { SqliteDriver } from "../driver.js";

import { captureCases, captureRuleCases } from "./capture.js";
import { compactionCases, sqliteMigrationCases } from "./compaction.js";
import { eventCases } from "./events.js";
import { readFilterCases } from "./read-filter.js";
import { stateCases } from "./state.js";
import { tablesCases } from "./tables.js";

/** Opens the database called `name`; the same name must open the same database again after `close`. */
export type OpenDriver = (name: string) => Promise<SqliteDriver>;

/** @deprecated the shared name is `SuiteCase`. */
export type { SuiteCase as DriverCase } from "@syncmesh/engine";

/**
 * The log and the state: what any `SqlDriver` must carry, whatever its dialect — the half of the
 * contract a Postgres adapter proves.
 *
 * @example
 * for (const c of storeTests(openDriver)) test(c.name, c.run);
 */
export function storeTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [...eventCases(openDriver), ...stateCases(openDriver), ...compactionCases(openDriver)];
}

/**
 * Change capture and the app's tables: what a driver of any dialect must carry for D20's write
 * path — the fold into real tables, and the app's own statements back out as changes.
 */
export function captureTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [...captureCases(openDriver), ...captureRuleCases(openDriver), ...tablesCases(openDriver)];
}

/**
 * The contract every `SqliteDriver` must satisfy, as named cases for any test runner: the stores,
 * plus the device-side half — tables, capture and read filters — that lives in SQLite DDL.
 *
 * @example
 * for (const c of driverTests(openDriver)) test(c.name, c.run);
 */
export function driverTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [
    ...storeTests(openDriver),
    ...sqliteMigrationCases(openDriver),
    ...captureTests(openDriver),
    ...readFilterCases(openDriver),
  ];
}

export { SuiteFailure as DriverTestFailure } from "@syncmesh/engine";
