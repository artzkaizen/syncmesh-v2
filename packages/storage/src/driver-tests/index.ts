import type { SuiteCase } from "@syncmesh/engine";

import type { SqliteDriver } from "../driver.js";

import { captureCases, captureRuleCases } from "./capture.js";
import { compactionCases } from "./compaction.js";
import { eventCases } from "./events.js";
import { stateCases } from "./state.js";
import { tablesCases } from "./tables.js";

/** Opens the database called `name`; the same name must open the same database again after `close`. */
export type OpenDriver = (name: string) => Promise<SqliteDriver>;

/** @deprecated the shared name is `SuiteCase`. */
export type { SuiteCase as DriverCase } from "@syncmesh/engine";

/**
 * The contract every `SqliteDriver` must satisfy, as named cases for any test runner.
 *
 * @example
 * for (const c of driverTests(openDriver)) test(c.name, c.run);
 */
export function driverTests(openDriver: OpenDriver): readonly SuiteCase[] {
  return [
    ...eventCases(openDriver),
    ...stateCases(openDriver),
    ...compactionCases(openDriver),
    ...captureCases(openDriver),
    ...captureRuleCases(openDriver),
    ...tablesCases(openDriver),
  ];
}

export { SuiteFailure as DriverTestFailure } from "@syncmesh/engine";
