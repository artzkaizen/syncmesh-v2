import type { EventStore } from "@syncmesh/engine";
import type { MergeSpec, PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { AppValue, Table } from "@syncmesh/schema";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";

import type { Revision } from "./history.js";

import { rowHistory } from "./history.js";

export interface HistoryViewOptions {
  /** Only this instance's writes count; omitted, the whole table. */
  readonly partition?: string;
}

/**
 * A revision at the string-named door: the table arrived as a name, so the columns are the
 * schema's, not the type system's.
 */
export type RevisionView = Omit<Revision<Table>, "changed" | "row"> & {
  /** What this write set; empty for a delete. */
  readonly changed: Readonly<Record<string, AppValue | undefined>>;
  /** The row as of this revision — the fold of every write up to it; `null` once deleted. */
  readonly row: Readonly<Record<string, AppValue | undefined>> | null;
};

/** `mesh.history` behind the mesh: the row's writes oldest-first, read by scanning the log. */
export function historyView(deps: {
  readonly schema: {
    readonly entries: readonly { readonly table: Table }[];
    readonly merge: MergeSpec;
  };
  readonly store: EventStore;
  readonly accountOf: (peer: PeerId) => string | undefined;
}): (
  table: string,
  key: string,
  options?: HistoryViewOptions,
) => Promise<ResultType<readonly RevisionView[], unknown>> {
  const entryOf = new Map(deps.schema.entries.map((e) => [String(e.table.name), e]));
  return (table, key, options = {}) =>
    Result.gen(async function* () {
      const entry = entryOf.get(table) ?? panic(`the manifest has no table "${table}"`);
      const entries = yield* Result.await(deps.store.all());
      const partition =
        options.partition === undefined ? undefined : yield* parsePartitionKey(options.partition);
      // SAFETY: keys are opaque strings in the kernel
      const rowKey = key as never;
      const revisions = rowHistory(entry.table, rowKey, entries, {
        merge: deps.schema.merge,
        partition,
        accountOf: deps.accountOf,
      });
      // SAFETY: the erased Table generic degenerates the cell types; every cell is an AppValue by construction
      return Result.ok(revisions as readonly RevisionView[]);
    });
}
