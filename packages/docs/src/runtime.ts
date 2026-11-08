import type { DocAddress, DocCoverStale, FoldBatch, StoreFailure } from "@syncmesh/engine";
import type { DocColumns, Hlc, PeerId, Procedure } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { docKey } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { AnyAdapter } from "./adapter.js";
import type { FlushError, OpenDoc, OpenError, Pacing } from "./documents.js";
import type { DocPending, DocTooLarge } from "./errors.js";
import type { DocsEngine } from "./materialise.js";

import { columnAdapter } from "./adapter.js";
import { DEFAULT_PACING, createHandles } from "./documents.js";
import { installCheckpoint, materialise, produceCheckpoint } from "./materialise.js";
import { replicaId } from "./replica.js";

/** What a background materialisation can fail with. */
export type MaintainError = OpenError | DocTooLarge | DocPending | DocCoverStale | StoreFailure;

/** What the runtime's own work — a materialisation, a paced flush — can fail with. */
export type BackgroundError = MaintainError | FlushError;

export interface DocumentsOptions {
  readonly engine: DocsEngine;
  /** The adapters this device can materialise; a column whose adapter is absent folds but cannot open (§10). */
  readonly adapters: readonly AnyAdapter[];
  /** The mesh's document columns: the same map the engine and validator were given. */
  readonly docs: DocColumns;
  /** The procedure every flush is recorded under. */
  readonly procedure: Procedure;
  readonly pacing?: Pacing;
  /**
   * Materialise a document once its tail passes the adapter's `snapshotEvery`/`snapshotEveryBytes`
   * (RFC-0023 §8.2), so its log may be trimmed. On by default.
   */
  readonly autoMaterialise?: boolean;
  /**
   * Where a failed background materialisation or paced flush goes. Absent, a materialisation is
   * retried at the next fold, and a flush's failure shows only as its handle's status.
   */
  readonly onError?: (error: BackgroundError) => void;
  readonly now?: () => Temporal.Instant;
  /** A fresh 16-byte nonce per replica; `crypto.getRandomValues` by default. */
  readonly nonce?: () => Uint8Array;
}

/**
 * The document runtime over one engine (RFC-0023 §4.3, §8): open a document column as the
 * adapter's own document, flush local edits as paced doc changes, apply remote ones as they fold,
 * materialise snapshots so the log can be trimmed, and produce or install checkpoints for joiners
 * below a compaction floor.
 *
 * @example
 * const documents = createDocuments({ engine, adapters: [loro()], docs: DOCS, procedure });
 * await using note = (await documents.open<LoroDoc>({ table, key, column })).unwrap();
 * note.value.getText("body").insert(0, "Hello");
 * note.value.commit(); // flushed as one doc change after 300 ms of quiet
 */
export function createDocuments(options: DocumentsOptions) {
  const { engine, docs } = options;
  const adapters = new Map(options.adapters.map((a) => [a.id, a]));
  const now = options.now ?? (() => Temporal.Now.instant());
  const nonce = options.nonce ?? (() => crypto.getRandomValues(new Uint8Array(16)));
  const fresh = () => replicaId(engine.peerId, nonce());
  const handles = createHandles({
    engine,
    docs,
    adapters,
    procedure: options.procedure,
    pacing: options.pacing ?? DEFAULT_PACING,
    nonce,
    ...(options.onError !== undefined && { onError: options.onError }),
  });

  const adapterAt = (address: DocAddress) => columnAdapter(docs, adapters, address);

  const materialiseAt = (address: DocAddress) =>
    Result.gen(async function* () {
      const adapter = yield* adapterAt(address);
      return Result.ok(yield* Result.await(materialise(engine, adapter, address, fresh(), now())));
    });

  // one materialisation per document at a time; a fold that lands meanwhile is picked up next
  const running = new Set<string>();
  const maintain = async (batch: FoldBatch) => {
    if (batch.docs === undefined) return;
    const heads = await engine.docHeads();
    if (heads.isErr()) return options.onError?.(heads.error);
    const touched = new Set(batch.docs.map((d) => docKey(d.entry)));
    for (const head of heads.value) {
      const key = docKey(head);
      const adapter = adapters.get(head.adapter);
      if (!touched.has(key) || running.has(key) || adapter === undefined) continue;
      const { snapshotEvery, snapshotEveryBytes } = adapter.limits;
      if (head.tailCount < snapshotEvery && head.tailBytes < snapshotEveryBytes) continue;
      running.add(key);
      const done = await materialiseAt(head);
      running.delete(key);
      if (done.isErr()) options.onError?.(done.error);
    }
  };
  const unmaintain =
    options.autoMaterialise === false ? () => {} : engine.onFoldBatch((b) => void maintain(b));

  return {
    /** Opens a document column; two opens share one replica, and the last close lets it go. */
    open: <D>(address: DocAddress): Promise<Result<OpenDoc<D>, OpenError>> =>
      handles.open<D>(address),
    /** Writes the snapshot and covers the tail it holds; compaction may then take those events. */
    materialise: materialiseAt,
    /** A signed {@link produceCheckpoint} of the document, with its snapshot bytes. */
    checkpoint: (address: DocAddress, producer: Identity, at: Hlc) =>
      Result.gen(async function* () {
        const adapter = yield* adapterAt(address);
        return Result.ok(
          yield* Result.await(produceCheckpoint(engine, adapter, address, producer, fresh(), at)),
        );
      }),
    /** Installs a checkpoint `producer` signed, with the snapshot it names (see {@link installCheckpoint}). */
    install: (wire: Uint8Array, producer: PeerId, snapshot: Uint8Array, address: DocAddress) =>
      Result.gen(async function* () {
        const adapter = yield* adapterAt(address);
        return Result.ok(
          yield* Result.await(
            installCheckpoint(engine, adapter, address, wire, producer, snapshot, fresh(), now()),
          ),
        );
      }),
    stop: () => {
      unmaintain();
      handles.stop();
    },
  };
}

export type Documents = ReturnType<typeof createDocuments>;
