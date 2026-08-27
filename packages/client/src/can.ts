import type { Engine, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey, Row } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { can as canOn } from "@syncmesh/engine";
import { parsePartitionKey, readRow } from "@syncmesh/kernel";

/** What answering "may I?" needs: the manifest, this device's rows, and the grant it holds. */
export interface CanDeps {
  readonly schema: ValidatorSchema;
  readonly engine: Engine;
  readonly grant: () => Grant | undefined;
  /** The partition kind a table belongs to, by name; `undefined` for a table the manifest lacks. */
  readonly kindOf: (table: string) => string | undefined;
}

/**
 * The instance whose `_policy` doc governs a question: the one the caller named, or — for a `user`
 * table, whose instance a grant already fixes — the account's own. Neither, and there is no doc to
 * look up, so the bundled rules are the answer. An unparsable name is treated the same way: `can`
 * returns a verdict, not a Result, and a name nobody can resolve must not become a silent verdict
 * of its own.
 */
function policyInstance(
  instance: string | undefined,
  kind: string | undefined,
  account: string | undefined,
): PartitionKey | undefined {
  if (instance !== undefined) return parsePartitionKey(instance).unwrapOr(undefined);
  if (kind !== "user" || account === undefined) return undefined;
  return parsePartitionKey(`user:${account}`).unwrapOr(undefined);
}

/**
 * `mesh.can`: the engine's verdict, reading the rules from where the write path reads them — the
 * instance's synced `_policy` row when this device holds one, the bundled manifest otherwise. A
 * UI asking the question and the validator answering it are then the same answer, which is the
 * whole point of asking before writing.
 */
export function createCan(deps: CanDeps) {
  const { schema, engine, grant, kindOf } = deps;
  return (what: `${string}.${string}`, row?: Row, instance?: string): boolean => {
    const held = grant();
    const partition = policyInstance(
      instance,
      kindOf(what.slice(0, what.indexOf("."))),
      held?.account,
    );
    if (partition === undefined) return canOn(schema, held, what, row);
    return canOn(schema, held, what, row, undefined, {
      partition,
      rows: (table, key) => readRow(engine.state(), table, key),
    });
  };
}
