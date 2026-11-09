import type { SuiteCase } from "@syncmesh/engine";

import type { SqlDriver } from "../driver.js";

import { blobLedgerCases } from "./blob-ledger.js";
import { blobCases } from "./blobs.js";
import { captureCases, captureRuleCases } from "./capture.js";
import { compactionCases } from "./compaction.js";
import { derivedColumnCases } from "./derived-columns.js";
import { docColumnCases } from "./doc-columns.js";
import { docCases } from "./docs.js";
import { eventCases } from "./events.js";
import { holeCases } from "./holes.js";
import { journalCases } from "./journal.js";
import { readFilterCases } from "./read-filter.js";
import { strictCases } from "./strict.js";

export { LADDER, PRINCIPALS, ROWS, RULES, asCells } from "./read-filter.js";
export { COUNTERS, JOBS, asFold, entry } from "./fixtures.js";
export {
  CRASH_AUTHOR,
  CRASH_BATCH,
  CRASH_SCHEMA,
  CRASH_TABLES,
  crashChild,
  crashTests,
  linesOf,
  type CrashChild,
  type CrashHarness,
  type CrashMode,
} from "./crash.js";
export { tornTests, type TornHarness } from "./torn.js";
import { stateCases } from "./state.js";
import { tablesCases } from "./tables.js";

/** Opens the database called `name`; the same name must open the same database again after `close`. */
export type OpenDriver = (name: string) => Promise<SqlDriver>;

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
  return [
    ...eventCases(openDriver),
    ...holeCases(openDriver),
    ...stateCases(openDriver),
    ...compactionCases(openDriver),
    ...blobCases(openDriver),
    ...blobLedgerCases(openDriver),
    ...docCases(openDriver),
  ];
}

/**
 * Change capture and the app's tables: what a driver of any dialect must carry for D20's write
 * path — the fold into real tables, and the app's own statements back out as changes.
 */
export function captureTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [
    ...captureCases(openDriver),
    ...captureRuleCases(openDriver),
    ...strictCases(openDriver),
    ...tablesCases(openDriver),
    ...journalCases(openDriver),
    ...docColumnCases(openDriver),
    ...derivedColumnCases(openDriver),
  ];
}

/**
 * The contract every `SqlDriver` must satisfy, as named cases for any test runner: the stores,
 * plus the device-side half — tables, capture and read filters — that lives in SQLite DDL. A
 * driver written in an app over its own binding runs the same suite the shipped adapters do.
 *
 * @example
 * for (const c of driverTests(openDriver)) test(c.name, c.run);
 */
export function driverTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [...storeTests(openDriver), ...captureTests(openDriver), ...readFilterCases(openDriver)];
}

export { SuiteFailure as DriverTestFailure } from "@syncmesh/engine";
