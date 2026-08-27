import type {
  CellValue,
  JsonValue,
  PartitionKey,
  Procedure,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { PolicyDoc } from "@syncmesh/policy";
import type { Result } from "@syncmesh/result";

import type { Engine, MutateOptions } from "./engine.js";
import type { MutateError } from "./errors.js";
import type { Tx } from "./tx.js";

/**
 * The three things an authority can do that a device cannot (RFC-0014). It is not a different
 * animal — same engine, same events, same signatures — it simply always runs, holds the whole
 * log, and its grant carries authority. Everything here is an ordinary signed event that every
 * peer folds by the ordinary rules.
 */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved tables' own names and keys, fixed by this module */
const POLICY = "_policy" as TableName;
const CORRECTIONS = "_corrections" as TableName;
const SET_POLICY = "_policy.set" as Procedure;
const CORRECT = "_corrections.write" as Procedure;
const column = (name: string) => name as never;
const rowKey = (key: string) => key as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** Names the reserved tables so a validator can hold them to the authority-only rule. */
export const RESERVED_TABLE_NAMES: ReadonlySet<string> = new Set([POLICY, CORRECTIONS]);

/**
 * Publishes the rules for one instance as data, so a permission change deploys by sync rather
 * than by app release. The row lives in the instance it governs, which is what makes it travel
 * to exactly the devices it binds, and every validator prefers it over the bundled manifest.
 *
 * ```ts
 * await setPolicy(engine, ACME, { jobs: { $default: deny, read: role("viewer") } })
 * ```
 */
export function setPolicy(
  engine: Engine,
  partition: PartitionKey,
  doc: PolicyDoc,
  options: { readonly version?: number } = {},
): Promise<Result<SyncEvent, MutateError>> {
  const version = options.version ?? Date.now();
  return engine.mutate(
    SET_POLICY,
    (tx: Tx) =>
      tx.insert(
        POLICY,
        rowKey(String(partition)),
        new Map([
          [column("id"), String(partition)],
          // SAFETY: a PolicyDoc is a plain-data AST — exactly what a json column holds
          [column("rules"), doc as JsonValue],
          [column("version"), version],
        ]),
      ),
    { partition } satisfies MutateOptions,
  );
}

/** What one correction records: the event it overrules, the row it fixes, and why. */
export interface Correction {
  /** The event whose value is being overruled — what a device shows next to the change. */
  readonly event: string;
  readonly table: TableName;
  readonly key: RowKey;
  /** Why, in the authority's words. Shown to a person, so write it for one. */
  readonly reason: string;
  readonly detail?: JsonValue;
  readonly partition: PartitionKey;
}

/**
 * The authority's answer to a write it will not accept. It cannot *reject*: a device that was
 * offline when the verdict was made would keep its provisional value forever, with nothing ever
 * contradicting it. So rejection is an **overwrite with a reason** — the corrected value and the
 * `_corrections` row in one signed event, which every peer folds by the ordinary merge, and
 * which a UI can render as "changed by the office, because …" rather than a silent revert.
 *
 * ```ts
 * await correct(engine, { event, table: JOBS, key, reason: "over the day limit", partition },
 *   (tx) => tx.update(JOBS, key, new Map([[HOURS, 8]])))
 * ```
 */
export function correct(
  engine: Engine,
  correction: Correction,
  fix: (tx: Tx) => void,
): Promise<Result<SyncEvent, MutateError>> {
  const { event, table, key, reason, detail, partition } = correction;
  const cells = new Map([
    [column("id"), `${event}:${String(table)}:${String(key)}`],
    [column("eventId"), event],
    [column("table"), String(table)],
    [column("key"), String(key)],
    [column("reason"), reason],
    [column("detail"), detail ?? null],
  ]);
  return engine.mutate(
    CORRECT,
    (tx: Tx) => {
      fix(tx); // the overwrite and its reason are one event: a peer cannot fold one without the other
      tx.insert(CORRECTIONS, rowKey(`${event}:${String(table)}:${String(key)}`), cells);
    },
    { partition } satisfies MutateOptions,
  );
}

/** A correction as a reader sees it. */
export interface CorrectionRow {
  readonly event: string;
  readonly table: string;
  readonly key: string;
  readonly reason: string;
  readonly detail: JsonValue | null;
}

/**
 * A reserved text column's cell. The column check proved it a string when the row was written,
 * so anything else here is a record this device should not have folded — read as absent rather
 * than stringified into `[object Object]`.
 */
const text = (value: CellValue | undefined): string => (isText(value) ? value : "");

/* oxlint-disable anti-slop/no-runtime-typeof -- the one narrowing of a stored cell back to its column's kind */
const isText = (value: CellValue | undefined): value is string => typeof value === "string";
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Every correction this device holds, oldest key first; `forEvent` narrows to one overruled write. */
export function corrections(engine: Engine): readonly CorrectionRow[] {
  const rows = engine.state().get(CORRECTIONS);
  if (rows === undefined) return [];
  return [...rows]
    .filter(([, record]) => record.deleteStamp === undefined)
    .map(([, record]) => {
      const cell = (name: string): CellValue | undefined => record.cells.get(column(name))?.value;
      return {
        event: text(cell("eventId")),
        table: text(cell("table")),
        key: text(cell("key")),
        reason: text(cell("reason")),
        // SAFETY: `detail` is a json column, so its cell is a JsonValue or null by the column check
        detail: (cell("detail") ?? null) as JsonValue | null,
      };
    })
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}
