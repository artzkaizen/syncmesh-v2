import type { ChangeMessage, SourceRow } from "@syncmesh/cdc";
import type { CellValue } from "@syncmesh/kernel";

import type { PgOutputMessage, Relation, Tuple, TupleCell } from "./pgoutput.js";

import { PartialKeyChange, UnkeyedChange } from "./replication-errors.js";
import { tableName } from "./slot.js";
import { cellValue } from "./values.js";

/** A relation as this session last described it, with the tuple positions that key its rows. */
export interface KnownRelation {
  readonly relation: Relation;
  readonly key: readonly number[];
}

type RowChange = Extract<PgOutputMessage, { t: "insert" | "update" | "delete" | "truncate" }>;

/**
 * One decoded row change as the port's messages. Throws {@link UnkeyedChange} for a change it
 * cannot key, and {@link PartialKeyChange} for a key change it cannot send whole; either ends the
 * stream it is read from — the stream's failure channel is its throw.
 */
export function portChanges(
  message: RowChange,
  relations: ReadonlyMap<number, KnownRelation>,
): readonly ChangeMessage[] {
  if (message.t === "truncate") {
    return message.relations.flatMap((oid) => {
      const known = relations.get(oid);
      return known === undefined
        ? []
        : [{ t: "truncate", table: tableName(known.relation) } as const];
    });
  }
  const known = relations.get(message.relation);
  if (known === undefined) {
    throw new UnkeyedChange({
      table: String(message.relation),
      message: `relation ${message.relation} was never described`,
    });
  }
  const { relation } = known;
  const table = tableName(relation);
  if (message.t === "insert") {
    return [{ t: "insert", table, row: sourceRow(relation, message.tuple) }];
  }
  const key = (tuple: Tuple) => rowKey(known, tuple);
  if (message.t === "delete") return [{ t: "delete", table, key: key(message.old.tuple) }];
  const full = message.old?.kind === "full" ? message.old.tuple : undefined;
  const after = sourceRow(relation, message.tuple, full);
  const now = key(message.tuple);
  const was = message.old === undefined ? now : key(message.old.tuple);
  if (was === now) return [{ t: "update", table, key: now, after }];
  // a changed key is a different row: the old one goes and the new one arrives, which is only
  // sound when it arrives whole — an update can leave a column out, an insert cannot
  const unsent = relation.columns.flatMap((column, i) =>
    column.name in after || message.tuple[i]?.kind !== "unchanged" ? [] : [column.name],
  );
  if (unsent.length > 0) {
    throw new PartialKeyChange({
      table,
      columns: unsent,
      message:
        `${table}: ${was} became ${now} without its unchanged TOAST value of ` +
        `${unsent.join(", ")}; the table needs REPLICA IDENTITY FULL`,
    });
  }
  return [
    { t: "delete", table, key: was },
    { t: "insert", table, row: after },
  ];
}

function rowKey(known: KnownRelation, tuple: Tuple): string {
  const table = tableName(known.relation);
  const columns = known.key;
  const only = columns.length === 1 ? columns[0] : undefined;
  const cell = only === undefined ? undefined : tuple[only];
  if (cell === undefined || cell.kind !== "text") {
    throw new UnkeyedChange({
      table,
      message:
        columns.length === 0
          ? `${table} has no replica identity to key a row by`
          : columns.length > 1
            ? `${table} is keyed by ${columns.length} columns; a mesh row has one key`
            : `${table}: the key column was not sent`,
    });
  }
  return cell.text;
}

const cell = (type: number, value: TupleCell): CellValue | undefined => {
  switch (value.kind) {
    case "null":
      return null;
    case "unchanged":
      return undefined;
    case "text":
      return cellValue(type, value.text);
    case "binary":
      return value.bytes;
  }
};

/** A tuple as the row the port carries; an unchanged TOAST value comes from `old` or stays out. */
function sourceRow(relation: Relation, tuple: Tuple, old?: Tuple): SourceRow {
  const row: Record<string, CellValue> = {};
  relation.columns.forEach((column, i) => {
    const value = tuple[i];
    if (value === undefined) return;
    const fallback = old?.[i];
    const read =
      value.kind === "unchanged" && fallback !== undefined
        ? cell(column.type, fallback)
        : cell(column.type, value);
    if (read !== undefined) row[column.name] = read;
  });
  return row;
}
