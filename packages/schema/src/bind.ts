import type { CellValue } from "@syncmesh/kernel";

import {
  allOf,
  allow,
  anyOf,
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
  readonly anyOf: (...of: readonly PolicyNode[]) => PolicyNode;
  readonly allOf: (...of: readonly PolicyNode[]) => PolicyNode;
  readonly not: (of: PolicyNode) => PolicyNode;
}

export type AllowFn<C extends Columns, R extends string> = (
  combinators: Combinators<C, R>,
) => AllowBlock;

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
    anyOf,
    allOf,
    not,
  };
}
