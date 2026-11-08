/**
 * D31's table and column states, as the ladder reads them: a dropped table is not unknown, and a
 * retired table or column refuses this device's own writes while every peer's still fold.
 */
import type { ColumnName, FoldableChange } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import type { ProbeEvent, ValidatorSchema } from "./validate.js";

import { RetiredWrite, TableDropped, UnknownTable } from "./errors.js";

type Entry = ValidatorSchema["entries"][number];

/**
 * The entry a change's table has, as this build may write it. No entry is a table it dropped
 * (D31) or one it never declared; a retired one refuses only a probe — this device's own write,
 * not yet numbered — since the same change from an older build still folds.
 */
export function resolveEntry(
  table: string,
  entry: Entry | undefined,
  event: Pick<ProbeEvent, "seqNum">,
  dropped: ReadonlySet<string> | undefined,
): Result<Entry, TableDropped | UnknownTable | RetiredWrite> {
  if (entry === undefined)
    return Result.err(
      dropped?.has(table) === true
        ? new TableDropped({
            table,
            message: "dropped from the schema; an older build still writes it",
          })
        : new UnknownTable({ table, message: "not in the schema" }),
    );
  if (entry.retired === true && event.seqNum === undefined)
    return Result.err(
      new RetiredWrite({ table, message: `${table} is retired: nothing here writes it` }),
    );
  return Result.ok(entry);
}

/** Whether the table declares the column retired. Own keys only: an inherited name is no column. */
const retiredColumn = (table: Table, column: ColumnName): boolean =>
  Object.hasOwn(table.columns, column) && table.columns[column]?.def.retired === true;

/**
 * The retired column a probe writes, if it writes one (D31). Only a probe: an older build's
 * numbered event still writes the column, and it folds, so retiring never strands anyone.
 */
export const retiredWrite = (table: Table, change: FoldableChange): RetiredWrite | undefined => {
  const columns =
    change.kind === "doc"
      ? [change.column]
      : change.kind === "delete"
        ? []
        : [...(change.kind === "insert" ? change.row : change.patch).keys()];
  const column = columns.find((name) => retiredColumn(table, name));
  if (column === undefined) return undefined;
  return new RetiredWrite({
    table: table.name,
    column,
    message: `${table.name}.${column} is retired: nothing here writes it`,
  });
};
