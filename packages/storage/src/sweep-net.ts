import type { Table } from "@syncmesh/schema";

import type { Net } from "./capture.js";
import type { SqlRow } from "./driver.js";

import { netEffects, parseImage } from "./capture.js";
import { valueColumns } from "./identifiers.js";

/** One logged cell, as a trigger's image holds it. */
type Logged = NonNullable<Net["before"]>[string];

/**
 * {@link netEffects} over writes that other, unlogged writes may have landed between: a staged
 * table's queue (RFC-0025), where a fold or a captured write can change a row between two filed
 * writes to it. Each row's `before` is rebuilt so that its net change is what the logged writes
 * themselves did — a column none of them changed is left out, so the mesh's own write keeps the
 * mesh's stamp, and a counter moves by the sum of their increments rather than by the fold's too.
 * A column something else wrote between two of them travels even when the last of them set it
 * back to its first value: the mesh may hold that other write's value, and the table holds theirs.
 * A row one of them inserted or deleted keeps its plain net: its change carries a whole image.
 */
export function netOfWrites(tables: ReadonlyMap<string, Table>, logged: readonly SqlRow[]) {
  const filed = new Map<
    string,
    {
      changed: Set<string>;
      moved: Map<string, number>;
      last: Map<string, Logged>;
      written: Set<string>;
    } | null
  >();
  for (const [tbl, key, , oldText, newText] of logged) {
    const id = `${String(tbl)} ${String(key)}`;
    const [old, next] = [parseImage(oldText), parseImage(newText)];
    const own = filed.get(id);
    if (own === null) continue;
    if (old === undefined || next === undefined) {
      filed.set(id, null);
      continue;
    }
    const writes = own ?? {
      changed: new Set<string>(),
      moved: new Map<string, number>(),
      last: new Map<string, Logged>(),
      written: new Set<string>(),
    };
    filed.set(id, writes);
    for (const [column, value] of Object.entries(next)) {
      // the row moved between the previous logged write and this one: something unlogged wrote it
      if (writes.last.has(column) && writes.last.get(column) !== old[column])
        writes.written.add(column);
      writes.last.set(column, value);
      if (value === old[column]) continue;
      writes.changed.add(column);
      const step = Number(value ?? 0) - Number(old[column] ?? 0);
      writes.moved.set(column, (writes.moved.get(column) ?? 0) + step);
    }
  }
  return netEffects(tables, logged).map((net) => {
    const writes = filed.get(`${net.table.name} ${String(net.key)}`);
    const { before, after } = net;
    if (writes == null || before === undefined || after === undefined) return net;
    const counters = new Set(
      valueColumns(net.table).flatMap(([key, , column]) =>
        column.def.merge === "counter" ? [key] : [],
      ),
    );
    const own = (column: string, value: Logged): Logged => {
      if (!writes.changed.has(column)) return value;
      if (counters.has(column) && value !== null)
        return Number(value) - (writes.moved.get(column) ?? 0);
      // any before other than `value` makes the column travel
      if (writes.written.has(column)) return value === null ? "" : null;
      return before[column] ?? null;
    };
    return {
      ...net,
      before: Object.fromEntries(
        Object.entries(after).map(([column, value]) => [column, own(column, value)]),
      ),
    };
  });
}
