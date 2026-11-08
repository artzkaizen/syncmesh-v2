import type { CellValue, ColumnName, Row, TableName } from "@syncmesh/kernel";

import { Result, panic } from "@syncmesh/result";

import type { AppValue } from "./convert.js";
import type { SchemaEntry } from "./manifest.js";
import type { Table } from "./table.js";

import { checkValue } from "./check.js";
import { toWireValue } from "./convert.js";
import { DeriveFailed } from "./documents.js";

/**
 * What one document column derives (RFC-0023 §4.1, §16.4): the target columns in manifest order,
 * how a replica holding the adapter computes them, and how a host without the functions checks
 * values it was handed.
 */
export interface DocDeriver {
  /** The derived columns, as the manifest's `derive` lists them. */
  readonly columns: readonly ColumnName[];
  /**
   * Runs every `from()` over the adapter's own document. A function that throws, or returns a
   * value its column cannot hold, is {@link DeriveFailed}; nothing is half-computed.
   */
  readonly compute: <D>(doc: D) => Result<Row, DeriveFailed>;
  /**
   * Checks values computed elsewhere — a device checkpoint's key 8 (§7.2) — against the columns:
   * each must be one of {@link DocDeriver.columns} and hold a value its kind accepts.
   */
  readonly check: (values: Row) => Result<Row, DeriveFailed>;
}

/**
 * Per table, per document column, its {@link DocDeriver}; a document column with no derive is
 * absent. Carries the schema's sealed partition kinds with it: a document in one has its derived
 * values computed on the device and never put in a checkpoint (RFC-0023 §11), and taking both from
 * one schema is what keeps a runtime from deriving without knowing which partitions are sealed.
 */
export interface Derivers extends ReadonlyMap<TableName, ReadonlyMap<ColumnName, DocDeriver>> {
  /** The schema's sealed partition kinds, as `schema.sealedKinds` holds them. */
  readonly sealedKinds: ReadonlySet<string>;
}

/** One target's value as the column holds it: the app's value in wire form, refused if its kind cannot hold it. */
function cell<V>(tbl: Table, target: ColumnName, value: V): Result<CellValue, DeriveFailed> {
  const column = tbl.columns[target] ?? panic(`${tbl.name}.${target}: not a column`);
  const failed = (message: string, cause?: unknown) =>
    new DeriveFailed({
      column: `${tbl.name}.${target}`,
      message: `${tbl.name}.${target}: ${message}`,
      ...(cause !== undefined && { cause }),
    });
  if (value === undefined) return Result.err(failed("the derive function returned undefined"));
  // SAFETY: checkValue below refuses anything that is not a cell of the column's kind
  const wire = toWireValue(value as AppValue);
  return checkValue(column, wire)
    .mapError((cause) => failed(cause.message, cause))
    .map(() => wire);
}

function createDeriver(entry: SchemaEntry, source: ColumnName): DocDeriver | undefined {
  const { table: tbl } = entry;
  const targets = Object.entries(entry.derive ?? {}).flatMap(([target, derivation]) =>
    derivation?.from === source
      ? [[tbl.columnNames[target] ?? panic(`${tbl.name}.${target}: unnamed`), derivation] as const]
      : [],
  );
  if (targets.length === 0) return undefined;
  const columns = targets.map(([target]) => target);
  return {
    columns,
    compute: (doc) =>
      Result.all(
        targets.map(([target, derivation]) =>
          Result.try({
            // SAFETY: the function was declared for this column's adapter, whose document `doc` is
            try: () => derivation.derive(doc as never),
            catch: (cause) =>
              new DeriveFailed({
                column: `${tbl.name}.${target}`,
                message: `${tbl.name}.${target}: the derive function threw`,
                cause,
              }),
          })
            .andThen((value) => cell(tbl, target, value))
            .map((value) => [target, value] as const),
        ),
      ).map((pairs) => new Map(pairs)),
    check: (values) =>
      Result.all(
        [...values].map(([target, value]) =>
          columns.includes(target)
            ? cell(tbl, target, value).map((checked) => [target, checked] as const)
            : Result.err(
                new DeriveFailed({
                  column: `${tbl.name}.${target}`,
                  message: `${tbl.name}.${target}: not derived from ${source}`,
                }),
              ),
        ),
      ).map((pairs) => new Map(pairs)),
  };
}

/**
 * The derive functions of every table, keyed by the document column each reads — what the
 * document runtime runs after a flush, a materialisation or a checkpoint install, and what an
 * opaque host checks a checkpoint's derived values against (RFC-0023 §16.4).
 *
 * @example
 * const derive = createDerivers(schema);
 * derive.get(notes.name)?.get(notes.columnNames.content)?.compute(doc); // Ok(Map { title → "Q3" })
 */
export function createDerivers(schema: {
  readonly entries: readonly SchemaEntry[];
  readonly sealedKinds: ReadonlySet<string>;
}): Derivers {
  const derivers = new Map<TableName, ReadonlyMap<ColumnName, DocDeriver>>();
  for (const entry of schema.entries) {
    const byDoc = new Map<ColumnName, DocDeriver>();
    for (const [key, column] of Object.entries(entry.table.columns)) {
      const name = entry.table.columnNames[key];
      if (column.def.doc === undefined || name === undefined) continue;
      const deriver = createDeriver(entry, name);
      if (deriver !== undefined) byDoc.set(name, deriver);
    }
    if (byDoc.size > 0) derivers.set(entry.table.name, byDoc);
  }
  return Object.assign(derivers, { sealedKinds: schema.sealedKinds });
}
