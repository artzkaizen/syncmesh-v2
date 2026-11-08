import type { CellValue } from "@syncmesh/kernel";

import {
  all,
  allow,
  any,
  claimEquals,
  claimHas,
  claimIncludes,
  deny,
  not,
  owner,
  patchOnly,
  role,
  rowIs,
  type AllowBlock,
  type PolicyNode,
} from "@syncmesh/policy";

import type { Columns } from "./table.js";

/** The combinators handed to a table's `allow`, typed to that table's columns and its kind's roles. A typo does not compile. */
export interface Combinators<C extends Columns, R extends string> {
  readonly allow: PolicyNode;
  readonly deny: PolicyNode;
  readonly role: (name: R) => PolicyNode;
  readonly owner: (column: keyof C & string) => PolicyNode;
  readonly claim: (name: string) => {
    readonly has: (column: keyof C & string) => PolicyNode;
    readonly equals: (column: keyof C & string) => PolicyNode;
  };
  /** `action` is in the grant's `permissions.<module>` list — for grants that carry a permission matrix. */
  readonly can: (module: string, action: string) => PolicyNode;
  readonly rowIs: (where: {
    readonly [K in keyof C & string]?: CellValue;
  }) => PolicyNode;
  readonly patchOnly: (columns: readonly (keyof C & string)[]) => PolicyNode;
  readonly any: (...of: readonly PolicyNode[]) => PolicyNode;
  readonly all: (...of: readonly PolicyNode[]) => PolicyNode;
  readonly not: (of: PolicyNode) => PolicyNode;
}

export type AllowFn<C extends Columns, R extends string> = (
  combinators: Combinators<C, R>,
) => AllowBlock;

/**
 * A table's field-level read rules (E06, D40): per column, who may read its value. Typed to the
 * table's own columns, so a rule for a column the table does not have does not compile.
 *
 * It holds only where an authority **serves rows** — a query answered on the server over the
 * caller's grant — because there the column is left out of what crosses. A device that syncs the
 * table's partition holds every column it was sent, signed, and there the rule is cosmetic: a
 * value its own queries read as `null` is still in its log. A column that must be secret from a
 * partition's members belongs in a table of its own, in a narrower or sealed partition.
 *
 * @example
 * ```ts
 * fields: ({ role, owner, any }) => ({ salary: any(role("hr"), owner("person")) })
 * ```
 */
export type FieldsFn<C extends Columns, R extends string> = (combinators: Combinators<C, R>) => {
  readonly [K in keyof C & string]?: PolicyNode;
};

/** The combinators are the same functions for every table; the type parameters are what bind them. */
export function combinators<C extends Columns, R extends string>(): Combinators<C, R> {
  return {
    allow,
    deny,
    role,
    owner,
    claim: (name) => ({
      has: (column) => claimHas(name, column),
      equals: (column) => claimEquals(name, column),
    }),
    can: (module, action) => claimIncludes(`permissions.${module}`, action),
    rowIs: (where) => {
      const present: Record<string, CellValue> = {};
      for (const [column, value] of Object.entries(where))
        if (value !== undefined) present[column] = value;
      return rowIs(present);
    },
    patchOnly,
    any,
    all,
    not,
  };
}
