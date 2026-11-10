import type { DocTail, TailUpdate } from "@syncmesh/engine";
import type { DocBlobRef, DocUpdate, PartitionKey } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { AnyAdapter } from "./adapter.js";
import type { DocsEngine } from "./materialise.js";

import { BlobUnavailable, UpdateTooLarge } from "./errors.js";

/**
 * Where a document's blob-carried updates live (RFC-0023 §5.4, D18): `mesh.blobs`, or any store
 * that puts bytes under their own hash and fetches them back verified. Given one, a flush past
 * the adapter's inline bound goes out as a blob reference instead of being refused, and an
 * update that arrived by reference is fetched before it is applied.
 */
export interface DocBlobs {
  /** Stores `bytes` and offers them to whoever can carry them; the hash names them in the change. */
  readonly put: (
    bytes: Uint8Array,
    options?: { readonly partition?: PartitionKey },
  ) => Promise<Result<string, unknown>>;
  /** The bytes behind `hash`, verified against it: this device's copy first, then its peers'. */
  readonly fetch: (hash: string) => Promise<Result<Uint8Array, unknown>>;
}

/**
 * How one flushed part travels: inline up to the adapter's `maxUpdateBytes`, and by reference
 * past it when there is a blob store, up to `maxSnapshotBytes`. Past either bound, or past the
 * inline one with no store, it is refused, and nothing of the burst is sent.
 */
export async function carry(
  adapter: AnyAdapter,
  parts: readonly Uint8Array[],
  blobs: DocBlobs | undefined,
  partition: PartitionKey | undefined,
): Promise<Result<readonly DocUpdate[], UpdateTooLarge | BlobUnavailable>> {
  const { maxUpdateBytes, maxSnapshotBytes } = adapter.limits;
  const limit = blobs === undefined ? maxUpdateBytes : maxSnapshotBytes;
  const over = parts.find((p) => p.length > limit);
  if (over !== undefined)
    return Result.err(
      new UpdateTooLarge({
        size: over.length,
        limit,
        message:
          blobs === undefined
            ? "the burst is over the inline bound, and no blob store was given to carry it"
            : "the burst is over the largest document the adapter keeps",
      }),
    );
  const updates: DocUpdate[] = [];
  for (const bytes of parts) {
    if (bytes.length <= maxUpdateBytes || blobs === undefined) {
      updates.push({ bytes });
      continue;
    }
    const put = await blobs.put(bytes, partition === undefined ? {} : { partition });
    if (put.isErr())
      return Result.err(
        new BlobUnavailable({ message: "the blob store refused the burst", cause: put.error }),
      );
    updates.push({ blob: { hash: put.value, size: bytes.length } });
  }
  return Result.ok(updates);
}

/**
 * The bytes behind one blob-carried update, or `undefined` while no carrier has them — or when
 * what came back is not the size the change names, which the fold has already recorded.
 */
export async function fetchUpdate(
  blobs: DocBlobs | undefined,
  blob: DocBlobRef,
): Promise<Uint8Array | undefined> {
  if (blobs === undefined) return undefined;
  const fetched = await blobs.fetch(blob.hash);
  return fetched.isOk() && fetched.value.length === blob.size ? fetched.value : undefined;
}

/**
 * A tail with every blob-carried update this device can fetch made inline, so a load, a
 * materialisation or a checkpoint takes it like any other; one no carrier holds yet stays a
 * reference and the document stays `behind` (RFC-0023 §5.4).
 */
export async function resolveTail(tail: DocTail, blobs: DocBlobs | undefined): Promise<DocTail> {
  if (blobs === undefined || tail.updates.every((u) => u.blob === undefined)) return tail;
  const updates = await Promise.all(
    tail.updates.map(async (u): Promise<TailUpdate> => {
      if (u.blob === undefined) return u;
      const bytes = await fetchUpdate(blobs, u.blob);
      return bytes === undefined ? u : { entry: u.entry, bytes };
    }),
  );
  return { ...tail, updates };
}

/**
 * The engine as the runtime reads it: with a blob store, every tail it loads, materialises or
 * checkpoints has its blob-carried updates fetched first (see {@link resolveTail}).
 */
export function withBlobs(engine: DocsEngine, blobs: DocBlobs | undefined): DocsEngine {
  if (blobs === undefined) return engine;
  return {
    peerId: engine.peerId,
    mutate: engine.mutate,
    onFoldBatch: engine.onFoldBatch,
    docTail: async (address) => {
      const tail = await engine.docTail(address);
      return tail.isErr() ? tail : Result.ok(await resolveTail(tail.value, blobs));
    },
    docLogOf: engine.docLogOf,
    docLineageLog: engine.docLineageLog,
    coverDoc: engine.coverDoc,
    docHeads: engine.docHeads,
    state: engine.state,
    cursors: engine.cursors,
    mayEditDoc: engine.mayEditDoc,
    writeDerived: engine.writeDerived,
    revert: engine.revert,
  };
}
