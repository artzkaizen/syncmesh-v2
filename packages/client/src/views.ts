import type { Engine, StoreFailure, StoredEvent } from "@syncmesh/engine";
import type { EventId, MergeSpec, PeerId, Procedure, Row as WireCells } from "@syncmesh/kernel";
import type { Table } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import type { Collection, Write, Writes } from "./collection.js";
import type { Placement } from "./context.js";
import type { TxError, WriteError } from "./errors.js";
import type { Visible } from "./live-query.js";

import { createCollection } from "./collection.js";
import { CrossPartitionTx } from "./errors.js";

export type AnyCollection = Collection<Table> & {
  readonly writes: Writes<Table>;
  readonly visible: Visible;
};

/** One committed `tx`: the event it appended, for `delivered` and `revert`. */
export interface TxReceipt {
  readonly eventId: EventId;
}

export interface TxOptions {
  /** The procedure label instead of the derived `table.op`; what `history` and provenance show. */
  readonly label?: string;
}

/** A set of collections over one placement rule — the ambient view, or a `scoped` one — and their `tx`. */
export interface View {
  readonly collections: Readonly<Record<string, AnyCollection>>;
  readonly tx: (
    fn: (collections: Record<string, Writes<Table>>) => Result<void, WriteError>,
    options?: TxOptions,
  ) => Promise<Result<TxReceipt, TxError>>;
}

export interface ViewDeps {
  readonly engine: Engine;
  readonly tables: Readonly<Record<string, Table>>;
  readonly merge: MergeSpec;
  readonly can: (what: `${string}.${string}`, row?: WireCells, patch?: WireCells) => boolean;
  /** Enforce `can` in the collections themselves — a view acting as someone other than the device. */
  readonly gated: boolean;
  readonly log: () => Promise<Result<readonly StoredEvent[], StoreFailure>>;
  readonly accountOf: (peer: PeerId) => string | undefined;
  readonly placementOf: (table: string) => Result<Placement, WriteError>;
  readonly scope?: string;
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- procedures are `table.op` labels (E09) */
const procedure = (label: string): Procedure => label as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export function createView(deps: ViewDeps): View {
  const { engine, tables, merge, can, gated, log, accountOf, placementOf, scope } = deps;
  const collections: Record<string, AnyCollection> = {};
  for (const [name, table] of Object.entries(tables)) {
    const collectionDeps = {
      engine,
      placement: () => placementOf(name),
      can,
      gated,
      log,
      merge,
      accountOf,
    };
    if (scope !== undefined) Object.assign(collectionDeps, { scope });
    collections[name] = createCollection(table, collectionDeps);
  }

  const tx: View["tx"] = (fn, options = {}) =>
    Result.gen(async function* () {
      const writes: (Write & { readonly table: string })[] = [];
      const recording: Record<string, Writes<Table>> = {};
      for (const [name, c] of Object.entries(collections))
        recording[name] = tapWrites(c.writes, (write) => writes.push({ ...write, table: name }));
      yield* fn(recording);
      const placements: Placement[] = [];
      for (const write of writes) placements.push(yield* placementOf(write.table));
      const distinct = [
        ...new Set(placements.map((p) => `${String(p.partition ?? "")}|${p.local === true}`)),
      ];
      if (distinct.length > 1) {
        return Result.err(
          new CrossPartitionTx({
            partitions: distinct,
            message: "a tx writes one partition; split it",
          }),
        );
      }
      const label = options.label ?? [...new Set(writes.map((w) => w.label))].join("+");
      const where = placements[0] ?? {};
      const event = yield* Result.await(
        engine.mutate(
          procedure(label),
          (t) => {
            for (const write of writes) write.apply(t);
          },
          where,
        ),
      );
      return Result.ok({ eventId: event.id });
    });

  return { collections, tx };
}

const tapWrites = (writes: Writes<Table>, record: (write: Write) => void): Writes<Table> => ({
  create: (row) => writes.create(row).map(tap(record)),
  update: (key, patch) => writes.update(key, patch).map(tap(record)),
  delete: (key) => writes.delete(key).map(tap(record)),
});

const tap =
  (record: (write: Write) => void) =>
  (write: Write): Write => {
    record(write);
    return write;
  };
