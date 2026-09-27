import type { AdapterId, DocColumns, MergeSpec } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { withDocColumns } from "@syncmesh/kernel";

import type { DocHead, DocLogEntry, DocStore } from "./doc-log.js";
import type { StoreFailure } from "./store.js";

import { createMemoryDocStore } from "./doc-log.js";

/** How an engine is told about documents. */
export interface DocEngineOptions {
  /**
   * The mesh's document columns (RFC-0023 §4.1). Their cells join by the lineage rule on every
   * path that joins a record — fold, repair, snapshot — and not by whatever `merge` defaults to.
   */
  readonly docs?: DocColumns;
  /**
   * The adapters this engine can materialise, by id. Absent or empty is the `adapter-missing`
   * mode every relay and not-yet-upgraded device runs: it folds, keeps and forwards doc changes
   * exactly as a device with the adapter does, and only labels them differently.
   */
  readonly docAdapters?: ReadonlySet<AdapterId>;
  /** Where the doc log and heads live; absent, an in-memory one. */
  readonly docStore?: DocStore;
}

/** What an engine answers about its documents. */
export interface DocApi {
  /** Every doc-log entry this engine holds (RFC-0023 §6.2). */
  readonly docLog: () => Promise<Result<readonly DocLogEntry[], StoreFailure>>;
  /** Every document's head: its winning lineage and where its tail stands. */
  readonly docHeads: () => Promise<Result<readonly DocHead[], StoreFailure>>;
}

type DocOptions = DocEngineOptions & { readonly merge?: MergeSpec | undefined };

/** What the engine threads through for documents. */
export interface DocPath {
  readonly store: DocStore;
  /** `merge` with every doc column under the lineage rule. */
  readonly merge: MergeSpec | undefined;
  readonly hasAdapter: (adapter: AdapterId) => boolean;
  readonly api: DocApi;
}

export function createDocPath(options: DocOptions): DocPath {
  const { docs, docAdapters, docStore = createMemoryDocStore() } = options;
  return {
    store: docStore,
    merge: docs === undefined ? options.merge : withDocColumns(options.merge, docs),
    hasAdapter: (adapter) => docAdapters?.has(adapter) === true,
    api: { docLog: docStore.entries, docHeads: docStore.heads },
  };
}
