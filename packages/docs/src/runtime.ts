import type { DocAddress, DocCoverStale, FoldBatch, StoreFailure } from "@syncmesh/engine";
import type { AdapterId, DocColumns, EventId, PeerId, Procedure } from "@syncmesh/kernel";
import type { DeriveFailed, Derivers } from "@syncmesh/schema";

import { docKey } from "@syncmesh/engine";
import { getRecord, kindOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { AnyAdapter } from "./adapter.js";
import type { DocBlobs } from "./blobs.js";
import type { FlushError, OpenDoc, OpenError, Pacing } from "./documents.js";
import type { DocPending, DocTooLarge } from "./errors.js";
import type { Derive, DocsEngine } from "./materialise.js";
import type { SealingKeys } from "./sealed-snapshot.js";

import { columnAdapter, resolveAdapterId } from "./adapter.js";
import { withBlobs } from "./blobs.js";
import { installProvisional } from "./checkpoint.js";
import { createCompensator } from "./compensate.js";
import { DEFAULT_PACING, createHandles, createRefs } from "./documents.js";
import { materialise } from "./materialise.js";
import { createRederive } from "./rederive.js";
import { replicaId } from "./replica.js";
import { createCheckpoints } from "./runtime-checkpoints.js";
import { createWrites } from "./write.js";

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
   * written to the local row, and again whenever the fold moves the document or rewrites its row
   * (see {@link Documents.rederive}). Its `sealedKinds` are the partitions whose checkpoints carry none
   * (§11), taken from the same schema so the two cannot disagree. Absent, no column is derived.
   */
  readonly derive?: Derivers;
  /**
   * The schema's sealed partition kinds (`schema.sealedKinds`, D40): a checkpoint of a document in
   * one carries no derived values and a snapshot sealed to the partition key (RFC-0023 §11).
   * Default `derive.sealedKinds`; give it where nothing is derived.
   */
  readonly sealedKinds?: ReadonlySet<string>;
  /**
   * This device's content keys for sealed partitions (its key ring): what a sealed partition's
   * checkpoint snapshot is sealed under by `checkpoint` and opened with by `install` (gaps U24).
   * Absent, both refuse a sealed partition's checkpoint rather than handle it in the clear.
   */
  readonly keys?: SealingKeys;
  readonly pacing?: Pacing;
  /**
   * Materialise a document once its tail passes the adapter's `snapshotEvery`/`snapshotEveryBytes`
   * (RFC-0023 §8.2), so its log may be trimmed. On by default.
   */
  readonly autoMaterialise?: boolean;
  /**
   * Recompute every row's derived columns once when the runtime starts, in the background (gaps
   * U25): what catches up rows rebuilt while it was not running — a fresh or repaired state
   * file — and a derive function that changed. On by default when `derive` is given; a host with
   * many documents and a state it knows is current may turn it off and call `rederive()` itself.
   */
  readonly rederiveAtStart?: boolean;
  /**
   * Where a failed background materialisation or paced flush goes. Absent, a materialisation is
   * retried at the next fold, and a flush's failure shows only as its handle's status.
   */
  readonly onError?: (error: BackgroundError) => void;
  readonly now?: () => Temporal.Instant;
  /**
   * Where blob-carried updates are put and fetched (RFC-0023 §5.4, D18): `mesh.blobs`. Given one,
   * a burst or a `replace()` past the adapter's inline `maxUpdateBytes` travels as a blob
   * reference, up to `maxSnapshotBytes`, and an update that arrived by reference is fetched before
   * it is applied, loaded or materialised. Absent, such a burst is refused (`UpdateTooLarge`) and
   * such an update leaves its document `behind`.
   */
  readonly blobs?: DocBlobs;
  /** A fresh 16-byte nonce per replica; `crypto.getRandomValues` by default. */
  readonly nonce?: () => Uint8Array;
}

/** Whether the row a document lives on is in a partition of a sealed kind (D40). */
const sealedAt = (
  engine: DocsEngine,
  kinds: ReadonlySet<string> | undefined,
  address: DocAddress,
) => {
  const partition = getRecord(engine.state(), address.table, address.key)?.partition;
  return partition !== undefined && kinds?.has(kindOf(partition)) === true;
};

/**
 * Materialises each document a fold touched once its tail passes the adapter's bounds (RFC-0023
 * §8.2): one materialisation per document at a time, and a fold that lands meanwhile is picked up
 * by the next.
 */
function createMaintain(
  engine: DocsEngine,
  adapters: ReadonlyMap<AdapterId, AnyAdapter>,
  materialiseAt: (address: DocAddress) => Promise<Result<unknown, MaintainError>>,
  onError: ((error: BackgroundError) => void) | undefined,
) {
  const running = new Set<string>();
  return async (batch: FoldBatch) => {
    if (batch.docs === undefined) return;
    const heads = await engine.docHeads();
    if (heads.isErr()) return onError?.(heads.error);
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
      if (done.isErr()) onError?.(done.error);
    }
  };
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
  const { docs, blobs, procedure } = options;
  const engine = withBlobs(options.engine, blobs);
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
  const sealed = (address: DocAddress) =>
    sealedAt(engine, options.sealedKinds ?? options.derive?.sealedKinds, address);
  // a checkpoint's last two arguments: whether its partition is sealed, and the keys it seals under
  const sealing = (address: DocAddress) => [sealed(address), options.keys] as const;
  const rederive =
    options.derive === undefined
      ? undefined
      : createRederive({
          engine,
          docs,
          adapters,
          derive: options.derive,
          replica: fresh,
          held: (address) => handles.held(address),
          ...(options.onError !== undefined && { onError: options.onError }),
        });
  // a flush's values ride its own write; the recomputation after its fold compares against them
  const flushDerive = (address: DocAddress): Derive<unknown> | undefined => {
    const computing = derive(address);
    if (computing === undefined) return undefined;
    return (doc) => {
      const values = computing(doc);
      rederive?.flushing(address, values, new Set(handles.held(address)?.seen.keys()));
      return values;
    };
  };
  const handles = createHandles({
    derive: flushDerive,
    onFlushFailed: (address) => rederive?.flushFailed(address),
    engine,
    docs,
    adapters,
    procedure: options.procedure,
    pacing: options.pacing ?? DEFAULT_PACING,
    nonce,
    ...(options.onError !== undefined && { onError: options.onError }),
    ...(blobs !== undefined && { blobs }),
  });
  const writes = createWrites({
    engine,
    docs,
    adapters,
    blobs,
    fresh,
    procedure,
    open: (address) => handles.open(address),
    held: (address) => handles.held(address),
    derive: flushDerive,
    onFailed: (address) => rederive?.flushFailed(address),
  });

  const adapterAt = (address: DocAddress) => columnAdapter(docs, adapters, address);

  const materialiseAt = (address: DocAddress) =>
    Result.gen(async function* () {
      const adapter = yield* adapterAt(address);
      return Result.ok(
        yield* Result.await(materialise(engine, adapter, address, fresh(), now(), derive(address))),
      );
    });

  const checkpoints = createCheckpoints({
    engine,
    docs,
    adapters,
    fresh,
    now,
    derive,
    sealing,
    adapterAt,
  });

  const compensator = createCompensator({ engine, docs, adapters, blobs, fresh });
  const maintain = createMaintain(engine, adapters, materialiseAt, options.onError);
  const unmaintain =
    options.autoMaterialise === false ? () => {} : engine.onFoldBatch((b) => void maintain(b));
  if (options.rederiveAtStart !== false) void rederive?.rederive();

  return {
    /** Opens a document column; two opens share one replica, and the last close lets it go. */
    open: <D>(address: DocAddress): Promise<Result<OpenDoc<D>, OpenError>> =>
      handles.open<D>(address),
    /** The stable {@link DocRef} of the document at `address`: the same object for the same address. */
    ref: createRefs((address) => handles.open(address)),
    /**
     * Flushes every open document now. A host calls it before it stops, so a burst still waiting
     * on its pacing is sent rather than lost; a failed flush goes to `onError`.
     */
    flush: () => handles.flushAll(),
    /** Writes the snapshot and covers the tail it holds; compaction may then take those events. */
    materialise: materialiseAt,
    /** A signed {@link produceCheckpoint} of the document, with its snapshot bytes. */
    checkpoint: checkpoints.checkpoint,
    /** Installs a checkpoint `producer` signed, with the snapshot it names (see {@link installCheckpoint}). */
    install: checkpoints.install,
    /**
     * The documents behind snapshot pages (E30 P5), signed as `producer`: what a mesh hands its
     * join exchange (`SnapshotDocs`), so a joiner takes each document's checkpoint with its row.
     */
    pages: checkpoints.pages,
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
    /**
     * Recomputes the derived columns of the document at `address`, or of every row when absent,
     * from the replica open there or from its snapshot and tail, and resolves once nothing is
     * queued (RFC-0023 §16.4). The runtime already does this whenever the fold moves a document
     * or rewrites its row, and once at start; an app calls it after rewriting rows outside
     * syncmesh. Does nothing without `derive`.
     */
    rederive: (address?: DocAddress) => rederive?.rederive(address) ?? Promise.resolve(),
    /**
     * Reverts one of the engine's last `undoDepth` writes (`engine.revert`) with its documents
     * taken back too (RFC-0023 §9): each edit by the adapter's `compensate`, against the document
     * as committed here, so later edits stand; a `replace()` by a genesis bringing back the
     * lineage it ended. A document another replace has moved on, or where nothing of the write
     * still shows, is reported `superseded`. Reverting the revert is redo.
     */
    revert: (id: EventId) => engine.revert(id, compensator),
    ...writes,
    stop: () => {
      unmaintain();
      rederive?.stop();
      handles.stop();
    },
  };
}

export type Documents = ReturnType<typeof createDocuments>;
