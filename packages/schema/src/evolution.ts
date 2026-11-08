import { Result, TaggedError } from "@syncmesh/result";

import type { EvolvingSchema, ShippedSchema, ShippedTable, ShippedColumn } from "./shipped.js";

import { shippedSchema } from "./shipped.js";

/**
 * Which rule a change broke (RFC-0013's verdict table, D31). Every one of them is a change an
 * older build, still writing and still reading, would meet as a refusal or a silently wrong row.
 *
 * - `table-removed` — a table left the manifest without being retired first, or without being
 *   named in `dropped`.
 * - `table-reused` — a dropped table's name is declared again; old writes would fold into it.
 * - `dropped-forgotten` — a name left `dropped`; its old writes would park as `unknown-table`.
 * - `table-moved` — a table changed partition kind, visibility or `sync`.
 * - `column-removed` — a column left its table without being retired first. A rename is this
 *   plus an add: add the new column and read `next ?? old` instead.
 * - `column-retyped` — a column's kind changed.
 * - `nullability-changed` — a column became nullable (an older build refuses the nulls) or
 *   NOT NULL (this build refuses the older nulls).
 * - `column-repurposed` — a column's merge, document adapter, derivation, key or uniqueness
 *   changed: the same name now means something else.
 * - `not-null-added` — a new column that is NOT NULL; the events written before it never carry it.
 * - `version-regressed` — `schemaVersion` went down.
 * - `version-not-raised` — the shape changed and `schemaVersion` did not.
 */
export type EvolutionRule =
  | "table-removed"
  | "table-reused"
  | "dropped-forgotten"
  | "table-moved"
  | "column-removed"
  | "column-retyped"
  | "nullability-changed"
  | "column-repurposed"
  | "not-null-added"
  | "version-regressed"
  | "version-not-raised";

/** One refused change. */
export interface EvolutionIssue {
  readonly rule: EvolutionRule;
  /** Absent for the two version rules, which are about the manifest. */
  readonly table?: string;
  readonly column?: string;
  readonly message: string;
}

/** The next manifest is not additive over the last one shipped; `issues` names every change. */
export class SchemaNotAdditive extends TaggedError("SchemaNotAdditive")<{
  issues: readonly EvolutionIssue[];
  message: string;
}> {}

const COLUMN_PURPOSE = ["merge", "doc", "derived", "primaryKey", "unique"] as const;

function columnIssues(table: string, before: ShippedTable, after: ShippedTable): EvolutionIssue[] {
  const issues: EvolutionIssue[] = [];
  for (const [name, was] of Object.entries(before.columns)) {
    const now = after.columns[name];
    if (now === undefined) {
      if (was.retired !== true)
        issues.push({
          rule: "column-removed",
          table,
          column: name,
          message: `${table}.${name} was removed without being retired first; a rename is an add plus \`next ?? ${name}\` at the read site`,
        });
      continue;
    }
    if (now.kind !== was.kind)
      issues.push({
        rule: "column-retyped",
        table,
        column: name,
        message: `${table}.${name} changed from ${was.kind} to ${now.kind}; add a new column instead`,
      });
    if (now.nullable !== was.nullable)
      issues.push({
        rule: "nullability-changed",
        table,
        column: name,
        message: `${table}.${name} became ${now.nullable ? "nullable" : "NOT NULL"}; ${now.nullable ? "an older build refuses its nulls" : "older rows hold nulls"}`,
      });
    const changed = COLUMN_PURPOSE.filter((aspect) => now[aspect] !== was[aspect]);
    if (changed.length > 0)
      issues.push({
        rule: "column-repurposed",
        table,
        column: name,
        message: `${table}.${name} changed its ${changed.join(", ")}; the same name would mean two things across builds`,
      });
  }
  for (const [name, now] of Object.entries(after.columns)) {
    if (Object.hasOwn(before.columns, name)) continue;
    if (!now.nullable && now.derived === undefined)
      issues.push({
        rule: "not-null-added",
        table,
        column: name,
        message: `${table}.${name} is new and NOT NULL; the events written before it never carry it`,
      });
  }
  return issues;
}

function tableIssues(shipped: ShippedSchema, next: ShippedSchema): EvolutionIssue[] {
  const issues: EvolutionIssue[] = [];
  const dropped = new Set(next.dropped);
  for (const name of shipped.dropped) {
    if (!dropped.has(name))
      issues.push({
        rule: "dropped-forgotten",
        table: name,
        message: `${name} left \`dropped\`; an older build's writes to it would park as unknown-table`,
      });
    if (Object.hasOwn(next.tables, name))
      issues.push({
        rule: "table-reused",
        table: name,
        message: `${name} was dropped and is declared again; an older build's writes would fold into it`,
      });
  }
  for (const [name, was] of Object.entries(shipped.tables)) {
    const now = next.tables[name];
    if (now === undefined) {
      if (was.retired !== true || !dropped.has(name))
        issues.push({
          rule: "table-removed",
          table: name,
          message:
            was.retired === true
              ? `${name} was removed; name it in \`dropped\` so older builds' writes to it park on their own`
              : `${name} was removed without being retired first`,
        });
      continue;
    }
    const moved = (["partition", "visibility", "sync"] as const).filter(
      (aspect) => now[aspect] !== was[aspect],
    );
    if (moved.length > 0)
      issues.push({
        rule: "table-moved",
        table: name,
        message: `${name} changed its ${moved.join(", ")}; add a new table instead`,
      });
    issues.push(...columnIssues(name, was, now));
  }
  return issues;
}

/** One column's facts as text, every field in a fixed order. */
const columnText = (column: ShippedColumn): string =>
  [
    column.kind,
    column.nullable,
    column.primaryKey,
    column.unique,
    column.merge ?? "",
    column.doc ?? "",
    column.derived ?? "",
    column.retired === true,
  ].join("|");

/** One table's facts as text, its columns sorted, so declaration order is not a change. */
const tableText = (table: ShippedTable): string =>
  [
    table.partition,
    table.visibility,
    table.sync ?? "",
    table.retired === true,
    ...Object.entries(table.columns)
      .map(([name, column]) => `${name}=${columnText(column)}`)
      .sort(),
  ].join(";");

/** Everything a version number stands for: what "the layout changed" compares. */
const layout = (schema: ShippedSchema): string =>
  [
    ...Object.entries(schema.tables)
      .map(([name, table]) => `${name}:${tableText(table)}`)
      .sort(),
    `dropped:${[...schema.dropped].sort().join(",")}`,
  ].join("\n");

/**
 * The additive lint D13 asked for (D31): the next manifest against the last one shipped, by
 * RFC-0013's verdict table. Adding a table, adding a nullable column, retiring a table or a
 * column, and removing what the last build had already retired are additive; the rest is named
 * in {@link SchemaNotAdditive}'s `issues`, every one of them, not the first.
 *
 * The rule it enforces is expand → wait for the fleet → retire → contract: a table or column is
 * retired in one build (still folded from older builds, no longer written here) and removed in a
 * later one, and a removed table's name goes in `dropped` for good. "Wait" is not checkable here;
 * `mesh.inspect.fleet.oldestSchema()` is the reading for it.
 *
 * Returns the next manifest's {@link ShippedSchema}, which is what to commit once it ships.
 *
 * @example
 * test("the schema is additive over the last shipped one", async () => {
 *   const shipped = parseShippedSchema(await Bun.file("schema.shipped.json").text()).unwrap();
 *   expect(checkEvolution(shipped, schema).isOk()).toBe(true);
 * });
 */
export function checkEvolution(
  shipped: ShippedSchema,
  schema: EvolvingSchema,
): Result<ShippedSchema, SchemaNotAdditive> {
  const next = shippedSchema(schema);
  const issues = tableIssues(shipped, next);
  if (next.schemaVersion < shipped.schemaVersion)
    issues.push({
      rule: "version-regressed",
      message: `schemaVersion went from ${shipped.schemaVersion} to ${next.schemaVersion}`,
    });
  else if (next.schemaVersion === shipped.schemaVersion && layout(next) !== layout(shipped))
    issues.push({
      rule: "version-not-raised",
      message: `the shape changed and schemaVersion is still ${next.schemaVersion}`,
    });
  if (issues.length === 0) return Result.ok(next);
  return Result.err(
    new SchemaNotAdditive({
      issues,
      message: issues.map((issue) => issue.message).join("; "),
    }),
  );
}
