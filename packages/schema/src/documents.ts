import type { ColumnName } from "@syncmesh/kernel";

import { TaggedError, panic } from "@syncmesh/result";

import type { Columns, Table } from "./table.js";

/**
 * A document adapter as a schema names it (RFC-0023 §4.1): a vetted, versioned package such as
 * `@syncmesh/loro`, never a function the app writes. The schema reads only `id`; the adapter's
 * operations live in the package and run after the fold, never in it.
 *
 * @template Doc The library's own document type that opening the column hands back.
 */
export interface DocumentAdapter<Doc = unknown> {
  /** `name@major`, the wire id every doc change carries — `"loro@1"`. */
  readonly id: `${string}@${number}`;
  /** Phantom: carries `Doc` for inference; never set. */
  readonly __doc?: Doc;
}

/** An adapter on a column whose storage is not bytes: the snapshot has nowhere to go. */
export class DocColumnNotBinary extends TaggedError("DocColumnNotBinary")<{
  column: string;
  message: string;
}> {}

/** An adapter on a key, `unique()` or `check()` column: none of those can hold a document. */
export class DocColumnConstraint extends TaggedError("DocColumnConstraint")<{
  column: string;
  message: string;
}> {}

/** A merge rule the column's kind cannot carry — D25's backstop for a cast past {@link MergeFor}. */
export class MergeKindMismatch extends TaggedError("MergeKindMismatch")<{
  column: string;
  message: string;
}> {}

/** A `derive` whose target or source is not what a derived column needs (RFC-0023 §4.1). */
export class InvalidDerive extends TaggedError("InvalidDerive")<{
  column: string;
  message: string;
}> {}

/**
 * A column whose value the materialiser computes from a document column of the same table: it
 * never travels and the app never writes it (RFC-0023 §4.1, §6.3).
 *
 * @template Source The document column read.
 * @template V The derived value.
 */
export interface Derivation<Source extends string = string, V = unknown> {
  readonly from: Source;
  /** Called with the adapter's document type; the parameter is `never` so any typed callback fits. */
  readonly derive: (doc: never) => V;
}

/**
 * Declares a derived column: `derive: { title: from("content", (d: LoroDoc) => …) }`.
 *
 * @example
 * from("content", (d: LoroDoc) => d.getText("title").toString()); // Derivation<"content", string>
 */
export const from = <const Source extends string, Doc, V>(
  source: Source,
  derive: (doc: Doc) => V,
): Derivation<Source, V> => ({ from: source, derive });

/**
 * Derived columns of a table: each target is computed from a document column of the same table,
 * so it never travels and the app never writes it (RFC-0023 §4.1).
 */
export type DeriveBlock<C extends Columns> = {
  readonly [K in keyof C & string]?: Derivation<keyof C & string>;
};

/**
 * One document column as the manifest's shareable half carries it (RFC-0023 §4.1) — plain data
 * the Rust and Swift ports read. The adapter and the derive functions stay JavaScript values.
 */
export interface DocColumnEntry {
  readonly column: ColumnName;
  /** The adapter's wire id, `"loro@1"`. */
  readonly doc: string;
  /** The columns derived from this one, in declaration order. */
  readonly derive: readonly ColumnName[];
}

/**
 * The table's document columns with what derives from each, after refusing any derive a
 * materialiser could not honour: a target that is missing, the key, a document, or also written
 * under a merge rule the app declared; a source that is not a document column of this table.
 *
 * @throws {InvalidDerive}
 */
export function docColumnsOf(
  name: string,
  tbl: Table,
  derive: DeriveBlock<Columns>,
): readonly DocColumnEntry[] {
  const refuse = (target: string, why: string): never => {
    const column = `${name}.${target}`;
    throw new InvalidDerive({ column, message: `${column}: derive ${why}` });
  };
  const derived = new Map<string, ColumnName[]>();
  for (const [target, derivation] of Object.entries(derive)) {
    if (derivation === undefined) continue;
    const def =
      tbl.columns[target]?.def ?? refuse(target, "names a column the table does not have");
    if (target === tbl.primaryKey) refuse(target, "cannot target the primary key");
    if (def.doc !== undefined) refuse(target, "cannot target a document column");
    if (def.merge !== undefined)
      refuse(target, `targets a column the app writes under merge "${def.merge}"`);
    if (tbl.columns[derivation.from]?.def.doc === undefined)
      refuse(target, `reads "${derivation.from}", which is not a document column of ${name}`);
    const targets = derived.get(derivation.from) ?? [];
    targets.push(tbl.columnNames[target] ?? panic(`${name}.${target}: unnamed column`));
    derived.set(derivation.from, targets);
  }
  return Object.entries(tbl.columns).flatMap(([key, column]) =>
    column.def.doc === undefined
      ? []
      : [
          {
            column: tbl.columnNames[key] ?? panic(`${name}.${key}: unnamed column`),
            doc: column.def.doc.adapter,
            derive: derived.get(key) ?? [],
          },
        ],
  );
}
