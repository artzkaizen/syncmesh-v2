import type { DocAddress, DocCoverStale, FoldBatch, StoreFailure } from "@syncmesh/engine";
import type { DocColumns, Hlc, PeerId, Procedure } from "@syncmesh/kernel";
import type { DeriveFailed, Derivers } from "@syncmesh/schema";
import type { Identity } from "@syncmesh/wire";

import { docKey } from "@syncmesh/engine";
import { getRecord, kindOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { AnyAdapter } from "./adapter.js";
import type { FlushError, OpenDoc, OpenError, Pacing } from "./documents.js";
import type { DocPending, DocTooLarge } from "./errors.js";
import type { Derive, DocsEngine } from "./materialise.js";

import { columnAdapter, resolveAdapterId } from "./adapter.js";
import { installProvisional } from "./checkpoint.js";
import { DEFAULT_PACING, createHandles } from "./documents.js";
import { installCheckpoint, materialise, produceCheckpoint } from "./materialise.js";
import { replicaId } from "./replica.js";

/** What a background materialisation can fail with. */
export type MaintainError = OpenError | DocTooLarge | DocPending | DocCoverStale | StoreFailure;

/**
 * What the runtime's own work — a materialisation, a paced flush, a derive function — can fail
 * with. A failed derive never fails the write it rides on: the column keeps its last value.
 */
export type BackgroundError = MaintainError | FlushError | DeriveFailed;

export interface DocumentsOptions {
  readonly engine: DocsEngine;
  /** The adapters this device can materialise; a column whose adapter is absent folds but cannot open (§10). */
  readonly adapters: readonly AnyAdapter[];
  /** The mesh's document columns: the same map the engine and validator were given. */
  readonly docs: DocColumns;
  /** The procedure every flush is recorded under. */
  readonly procedure: Procedure;
  /**
   * The schema's derive functions (`createDerivers(schema)`, RFC-0023 §16.4): after every flush of
   * an open document and every materialisation, the row's derived columns are computed here and
   * written to the local row. Absent, no column is derived.
   */
  readonly derive?: Derivers;
  /**
   * The schema's sealed partition kinds (`schema.sealedKinds`): a checkpoint of a document in one
   * carries no derived values, since they would be plaintext read out of sealed content (§11).
   */
  readonly sealedKinds?: ReadonlySet<string>;
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
  const deriverAt = (address: DocAddress) =>
    options.derive?.get(address.table)?.get(address.column);
  const derive = (address: DocAddress): Derive<unknown> | undefined => {
    const deriver = deriverAt(address);
    if (deriver === undefined) return undefined;
    return (doc) => {
      const computed = deriver.compute(doc);
      if (computed.isErr()) options.onError?.(computed.error);
      return computed.isOk() ? computed.value : undefined;
    };
  };
  const sealed = (address: DocAddress) => {
    const partition = getRecord(engine.state(), address.table, address.key)?.partition;
    return partition !== undefined && options.sealedKinds?.has(kindOf(partition)) === true;
  };
  const handles = createHandles({
    derive,
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
      return Result.ok(
        yield* Result.await(materialise(engine, adapter, address, fresh(), now(), derive(address))),
      );
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
          yield* Result.await(
            produceCheckpoint(
              engine,
              adapter,
              address,
              producer,
              fresh(),
              at,
              derive(address),
              sealed(address),
            ),
          ),
        );
      }),
    /** Installs a checkpoint `producer` signed, with the snapshot it names (see {@link installCheckpoint}). */
    install: (wire: Uint8Array, producer: PeerId, snapshot: Uint8Array, address: DocAddress) =>
      Result.gen(async function* () {
        const adapter = yield* adapterAt(address);
        return Result.ok(
          yield* Result.await(
            installCheckpoint(
              engine,
              adapter,
              address,
              wire,
              producer,
              snapshot,
              fresh(),
              now(),
              derive(address),
            ),
          ),
        );
      }),
    /**
     * What an opaque host — no adapter, or a sealed partition — does with a device's checkpoint
     * (see {@link installProvisional}): keeps its snapshot and writes the derived values key 8
     * carries, unverified beyond what a host without the adapter can check.
     */
    installProvisional: (
      wire: Uint8Array,
      producer: PeerId,
      snapshot: Uint8Array,
      address: DocAddress,
    ) =>
      Result.gen(async function* () {
        const adapter = yield* resolveAdapterId(docs, address);
        const deriver = deriverAt(address);
        return Result.ok(
          yield* Result.await(
            installProvisional(engine, address, wire, producer, snapshot, now(), {
              adapter,
              sealed: sealed(address),
              ...(deriver !== undefined && { deriver }),
            }),
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
