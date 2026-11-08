import type { Author, Engine, PolicyWhy, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey, Row, RowKey, TableName } from "@syncmesh/kernel";

import { can as canOn, why as whyOn } from "@syncmesh/engine";
import { parsePartitionKey, readRow } from "@syncmesh/kernel";

/** What answering "may I?" needs: the manifest, this device's rows, and who it is writing as. */
export interface CanDeps {
  readonly schema: ValidatorSchema;
  readonly engine: Engine;
  /**
   * The principal the validator would build for this device, from `openAccounts` — the grant
   * where an issuer is configured, the instance's `_links` row where none is. Read a grant here
   * instead and `can` answers false for every write an ungranted accounts mesh admits, which
   * would leave the button and the write disagreeing in exactly the mesh links exist for.
   */
  readonly author: (partition?: PartitionKey) => Author | undefined;
}

/** A manifest entry, as far as {@link tableKinds} reads it. */
interface Entry {
  readonly table: { readonly name: string };
  readonly partition?: string;
}

/** {@link CanDeps.kindOf} over a manifest's entries: each table's partition kind, by name. */
export const tableKinds = (entries: readonly Entry[]) => {
  const byName = new Map(entries.map((e) => [e.table.name, e.partition]));
  return (table: string) => byName.get(table);
};

/**
 * The instance a `user` table's rules are looked up in when the caller named none: the account's
 * own, which is the only instance such a row can be written to. Any other table has nothing to
 * resolve, so the bundled rules are the answer.
 */
function userInstance(kind: string | undefined, account: string | undefined) {
  if (kind !== "user" || account === undefined) return undefined;
  return parsePartitionKey(`user:${account}`).unwrapOr(undefined);
}

/**
 * `mesh.can` and `mesh.inspect.why`: the engine's verdict, reading the rules from where the write
 * path reads them — the instance's synced `_policy` row when this device holds one, the bundled
 * manifest otherwise. A UI asking the question and the validator answering it are then the same
 * answer, which is the whole point of asking before writing. `why` is the same answer with its
 * reasons: which rung, which rule, and the leaves of it that decided.
 *
 * An unparsable instance resolves to no instance at all: `can` returns a verdict, not a Result,
 * and a name nobody can resolve must not become a silent verdict of its own.
 */
export function createPolicyQuestions(deps: CanDeps) {
  const { schema, engine, author } = deps;
  const tableKind = tableKinds(schema.entries);
  /** Who is asking, and the instance whose rules bind, as validation would resolve them. */
  const resolve = (what: `${string}.${string}`, instance: string | undefined) => {
    const named =
      instance === undefined ? undefined : parsePartitionKey(instance).unwrapOr(undefined);
    const held = author(named);
    const partition =
      instance === undefined
        ? userInstance(tableKind(what.slice(0, what.indexOf("."))), held?.account)
        : named;
    const source =
      partition === undefined
        ? undefined
        : {
            partition,
            rows: (table: TableName, key: RowKey) => readRow(engine.state(), table, key),
          };
    return { held, source };
  };
  return {
    can: (what: `${string}.${string}`, row?: Row, instance?: string): boolean => {
      const { held, source } = resolve(what, instance);
      return canOn(schema, held, what, row, undefined, source);
    },
    why: (what: `${string}.${string}`, row?: Row, instance?: string): PolicyWhy => {
      const { held, source } = resolve(what, instance);
      return whyOn(schema, held, what, row, undefined, source);
    },
  };
}
