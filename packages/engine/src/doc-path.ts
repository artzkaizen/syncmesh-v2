import type {
  AdapterId,
  DocBlobRef,
  DocColumns,
  LineageId,
  MergeSpec,
  PeerId,
  SeqNum,
  State,
} from "@syncmesh/kernel";

import { getRecord, docLineage, withDocColumns } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";
import { bytesEqual } from "@syncmesh/wire";

import type {
  DocAddress,
  DocCover,
  DocHead,
  DocLogEntry,
  DocSnapshot,
  DocStore,
} from "./doc-log.js";
import type { AtomicStores } from "./engine.js";
import type { FoldPath } from "./fold.js";
import type { EventStore } from "./store.js";
import type { Cursors } from "./sync.js";
import type { Undo } from "./undo.js";

import { createMemoryDocStore } from "./doc-log-memory.js";
import { DocCoverStale, docKey } from "./doc-log.js";
import { StoreFailure } from "./store.js";

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

/** A tail entry with what it carries: its bytes inline, or the blob that holds them. */
export type TailUpdate =
  | { readonly entry: DocLogEntry; readonly bytes: Uint8Array; readonly blob?: never }
  | { readonly entry: DocLogEntry; readonly blob: DocBlobRef; readonly bytes?: never };

/**
 * What a document is opened from (RFC-0023 §4.3): its winning lineage, the snapshot persisted on
 * it, and every update on it the snapshot does not hold, by author, sequence and index.
 */
export interface DocTail {
  readonly lineage?: LineageId;
  readonly head?: DocHead;
  /** Absent when none was persisted, or the one persisted is of a lineage that no longer wins. */
  readonly snapshot?: DocSnapshot;
  readonly updates: readonly TailUpdate[];
}

/** What an engine answers about its documents. */
export interface DocApi {
  /** Every doc-log entry this engine holds (RFC-0023 §6.2). */
  readonly docLog: () => Promise<Result<readonly DocLogEntry[], StoreFailure>>;
  /** Every document's head: its winning lineage and where its tail stands. */
  readonly docHeads: () => Promise<Result<readonly DocHead[], StoreFailure>>;
  /** One document's snapshot and tail, read back from the log its events are kept in. */
  readonly docTail: (doc: DocAddress) => Promise<Result<DocTail, StoreFailure>>;
  /**
   * Commits a materialised snapshot or an installed checkpoint, in the write transaction when the
   * engine has one (RFC-0023 §6.3). The entries it covers become compactable (§8.3). The cover's
   * derived values land in the row in the same commit, and a live query reading them re-runs.
   */
  readonly coverDoc: (
    doc: DocAddress,
    cover: DocCover,
  ) => Promise<Result<void, StoreFailure | DocCoverStale>>;
}

/** What the doc path reads once the engine has built it: state, coverage, the transaction. */
export interface DocBindings {
  readonly getState: () => State;
  readonly synced: () => ReadonlyMap<PeerId, SeqNum>;
  readonly atomically: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
  /** Writes a cover's derived values into the row, inside its transaction (RFC-0023 §16.4). */
  readonly derive: FoldPath["derive"];
  readonly notifyDerived: FoldPath["notifyDerived"];
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
  /** Hands the path what exists only after the fold path is built. Called once, at construction. */
  readonly bind: (bindings: DocBindings) => void;
  /**
   * The stores a transaction writes through, with the doc log this engine reads. A scope's own
   * doc store is taken only when the engine was given one — the same database, in the same
   * transaction; an engine keeping its doc log in memory keeps writing it there, or its reads
   * and its writes would be two different logs.
   */
  readonly within: (scoped: AtomicStores) => AtomicStores;
  /**
   * What compaction is clamped by: the doc log's uncovered entries, and {@link DocPath.hold}.
   * `docsPersist` is false for the in-memory doc log an engine keeps when given none.
   */
  readonly compaction: {
    readonly docs: DocStore;
    readonly docsPersist: boolean;
    readonly held: () => Cursors;
  };
}

export function createDocPath(
  options: DocOptions & { readonly store: EventStore },
  peerId: PeerId,
  undo: readonly Undo[],
): DocPath {
  const { docs, docAdapters, docStore = createMemoryDocStore() } = options;
  let bound: DocBindings | undefined;
  const bindings = () => bound ?? panicUnbound();
  let covering = Promise.resolve();
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
    api: {
      docLog: docStore.entries,
      docHeads: docStore.heads,
      docTail: (doc) => readTail(options.store, docStore, bindings(), doc),
      coverDoc: (doc, cover) => {
        const derived =
          cover.derived === undefined
            ? []
            : [{ table: doc.table, key: doc.key, values: cover.derived }];
        // one at a time, so no cover reads a head another is about to move
        const next = covering
          .then(() =>
            Result.tryPromise({
              try: () =>
                bindings().atomically(async (scoped) => {
                  const done = await coverIfCurrent(
                    scoped.docs ?? docStore,
                    bindings(),
                    doc,
                    cover,
                  );
                  if (done.isOk()) await bindings().derive(derived, scoped);
                  return done;
                }),
              // a derived write the store refused inside the transaction, rolling the cover back
              catch: (cause) =>
                cause instanceof StoreFailure
                  ? cause
                  : new StoreFailure({ message: "the cover's transaction failed", cause }),
            }),
          )
          .then((done) => {
            const covered = done.andThen((inner) => inner);
            if (covered.isOk()) bindings().notifyDerived(derived);
            return covered;
          });
        covering = next.then(settled, settled);
        return next;
      },
    },
    bind: (next) => {
      bound = next;
    },
    within: (scoped) =>
      options.docStore !== undefined && scoped.docs !== undefined
        ? scoped
        : { ...scoped, docs: docStore },
    compaction: { docs: docStore, docsPersist: options.docStore !== undefined, held: hold },
  };
}

/**
 * Commits `cover` unless the head it was built on has moved, or its lineage no longer wins. The
 * check holds within one engine, whose covers run one at a time; a doc store shared by two
 * engines is not guarded by it.
 */
function coverIfCurrent(
  docStore: DocStore,
  { getState }: DocBindings,
  doc: DocAddress,
  cover: DocCover,
): Promise<Result<void, StoreFailure | DocCoverStale>> {
  return Result.gen(async function* () {
    const heads = yield* Result.await(docStore.heads());
    const held = heads.find((h) => docKey(h) === docKey(doc))?.version;
    const winner = docLineage(getRecord(getState(), doc.table, doc.key), doc.column);
    const moved =
      held === undefined || cover.base === undefined
        ? held !== cover.base
        : !bytesEqual(held, cover.base);
    if (moved || winner !== cover.lineage)
      return Result.err(
        new DocCoverStale({
          ...doc,
          message: moved
            ? "another snapshot was committed after this one was built"
            : "the snapshot is of a lineage that no longer wins",
        }),
      );
    return Result.ok(yield* Result.await(docStore.cover(doc, cover)));
  });
}

const settled = () => {};

const panicUnbound = (): never => panic("the doc path was read before the engine bound it");

function readTail(
  events: EventStore,
  docStore: DocStore,
  { getState, synced }: DocBindings,
  doc: DocAddress,
): Promise<Result<DocTail, StoreFailure>> {
  return Result.gen(async function* () {
    const lineage = docLineage(getRecord(getState(), doc.table, doc.key), doc.column);
    const entries = yield* Result.await(docStore.entriesOf(doc));
    const heads = yield* Result.await(docStore.heads());
    const head = heads.find((h) => docKey(h) === docKey(doc));
    const held = yield* Result.await(docStore.snapshotOf(doc));
    const live = entries.filter(
      (e) => e.lineage === lineage && (e.state === "tail" || e.state === "bytes-missing"),
    );
    // one read of the log: every author the tail names from just below its first entry, and
    // every other author from where this engine already holds them, so nothing else comes back
    const floor = new Map(synced());
    for (const e of live) {
      // SAFETY: one below a positive sequence; 0 reads the author's whole log
      const below = (e.seq - 1) as SeqNum;
      const at = floor.get(e.author);
      if (at === undefined || below < at) floor.set(e.author, below);
    }
    const found = live.length === 0 ? [] : yield* Result.await(events.allSince(floor));
    const byId = new Map(found.map((s) => [`${s.event.peerId}\u0000${String(s.event.seqNum)}`, s]));
    const updates = live.flatMap((entry): TailUpdate[] => {
      const change = byId.get(`${entry.author}\u0000${String(entry.seq)}`)?.event.changes[
        entry.index
      ];
      if (change?.kind !== "doc") return [];
      const { update } = change;
      return update.bytes !== undefined
        ? [{ entry, bytes: update.bytes }]
        : [{ entry, blob: update.blob }];
    });
    return Result.ok({
      updates,
      ...(lineage !== undefined && { lineage }),
      ...(head !== undefined && { head }),
      ...(held !== undefined && held.lineage === lineage && { snapshot: held }),
    });
  });
}
