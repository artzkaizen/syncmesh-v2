import type { AdapterId, DocColumns, MergeSpec, PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { withDocColumns } from "@syncmesh/kernel";

import type { DocHead, DocLogEntry, DocStore } from "./doc-log.js";
import type { StoreFailure } from "./store.js";
import type { Cursors } from "./sync.js";
import type { Undo } from "./undo.js";

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
  /**
   * The floor this engine's own undo ring holds: the oldest revertable write that carries a doc
   * change pins its author's log below it, because undoing a document needs that action's own
   * updates back and only the log still has them (RFC-0023 §8.3).
   */
  readonly hold: () => Cursors;
  readonly api: DocApi;
  /** What compaction is clamped by: the doc log's uncovered entries, and {@link DocPath.hold}. */
  readonly compaction: { readonly docs: DocStore; readonly held: () => Cursors };
}

export function createDocPath(options: DocOptions, peerId: PeerId, undo: readonly Undo[]): DocPath {
  const { docs, docAdapters, docStore = createMemoryDocStore() } = options;
  const hold = (): Cursors => {
    const oldest = undo.find(
      (u) => u.event.local !== true && u.event.changes.some((c) => c.kind === "doc"),
    );
    if (oldest === undefined) return new Map();
    // SAFETY: one below a positive sequence; 0 holds the whole of this author's log
    return new Map([[peerId, (oldest.event.seqNum - 1) as SeqNum]]);
  };
  return {
    store: docStore,
    merge: docs === undefined ? options.merge : withDocColumns(options.merge, docs),
    hasAdapter: (adapter) => docAdapters?.has(adapter) === true,
    hold,
    api: { docLog: docStore.entries, docHeads: docStore.heads },
    compaction: { docs: docStore, held: hold },
  };
}
