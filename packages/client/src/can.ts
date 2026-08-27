import type { Author, Engine, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey, Row } from "@syncmesh/kernel";

import { can as canOn } from "@syncmesh/engine";
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
  /** The partition kind a table belongs to, by name; `undefined` for a table the manifest lacks. */
  readonly kindOf: (table: string) => string | undefined;
}

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
 * `mesh.can`: the engine's verdict, reading the rules from where the write path reads them — the
 * instance's synced `_policy` row when this device holds one, the bundled manifest otherwise. A
 * UI asking the question and the validator answering it are then the same answer, which is the
 * whole point of asking before writing.
 *
 * An unparsable instance resolves to no instance at all: `can` returns a verdict, not a Result,
 * and a name nobody can resolve must not become a silent verdict of its own.
 */
export function createCan(deps: CanDeps) {
  const { schema, engine, author, kindOf } = deps;
  return (what: `${string}.${string}`, row?: Row, instance?: string): boolean => {
    const named =
      instance === undefined ? undefined : parsePartitionKey(instance).unwrapOr(undefined);
    const held = author(named);
    const partition =
      instance === undefined
        ? userInstance(kindOf(what.slice(0, what.indexOf("."))), held?.account)
        : named;
    if (partition === undefined) return canOn(schema, held, what, row);
    return canOn(schema, held, what, row, undefined, {
      partition,
      rows: (table, key) => readRow(engine.state(), table, key),
    });
  };
}
