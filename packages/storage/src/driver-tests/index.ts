import type { SqliteDriver } from "../driver.js";

import { compactionCases } from "./compaction.js";
import { eventCases } from "./events.js";
import { stateCases } from "./state.js";

/** Opens the database called `name`; the same name must open the same database again after `close`. */
export type OpenDriver = (name: string) => Promise<SqliteDriver>;

export interface DriverCase {
  readonly name: string;
  /** Rejects with `DriverTestFailure` (or whatever the driver threw) when the contract does not hold. */
  readonly run: () => Promise<void>;
}

/**
 * The contract every `SqliteDriver` must satisfy, as named cases for any test runner.
 *
 * @example
 * for (const c of driverTests(openDriver)) test(c.name, c.run);
 */
export function driverTests(openDriver: OpenDriver): readonly DriverCase[] {
  return [...eventCases(openDriver), ...stateCases(openDriver), ...compactionCases(openDriver)];
}

export { DriverTestFailure } from "./assert.js";
