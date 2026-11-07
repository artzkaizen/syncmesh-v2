import type { PartitionKey } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { BlobError, BlobHash, BlobStore } from "@syncmesh/storage";
import type { Transport } from "@syncmesh/transport";

import { Result as R } from "@syncmesh/result";
import {
  BlobNotFound,
  BlobQuotaExceeded,
  BlobTimeout,
  hashOf,
  memoryBlobStore,
  verifyBlob,
} from "@syncmesh/storage";
import { BLOB_MISSING } from "@syncmesh/transport";

import { NoSuchCapability } from "./errors.js";
import { meterBlobs } from "./inspect.js";

export interface Blobs {
  /**
   * Stores the bytes locally under their own hash and offers them to every transport that can
   * carry them. The hash is what a row then references — put first, write the row second, so a
   * peer that sees the row can already fetch what it names.
   *
   * `BlobQuotaExceeded` when a relay refused them because the partition they are billed to is
   * full: that relay stored nothing, so this device is still their only holder.
   */
  readonly put: (
    bytes: Uint8Array,
    options?: PutBlobOptions,
  ) => Promise<Result<BlobHash, BlobError | BlobQuotaExceeded | NoSuchCapability>>;
  /**
   * The bytes behind a hash: this device's cache first, then whoever can be asked. Verified on
   * arrival — a reference is a proof of content, not a promise about a server — and cached, since
   * a device's copy is an eviction candidate rather than an obligation (D18).
   *
   * `BlobNotFound` when every carrier asked said it holds none — a stale reference, recoverable by
   * anyone who still has the bytes putting them back; `BlobTimeout` when one stayed silent.
   */
  readonly fetch: (
    hash: BlobHash,
    options?: FetchBlobOptions,
  ) => Promise<Result<Uint8Array, BlobError | NoSuchCapability>>;
  /**
   * The same bytes as a stream — what a video player reads without a whole buffer forced into
   * memory at the consumer (book ch. 12). Chunked delivery below this seam arrives with the
   * peer session's blob frames; the surface is already the one it will keep.
   */
  readonly stream: (hash: BlobHash, options?: FetchBlobOptions) => ReadableStream<Uint8Array>;
  /**
   * Refcounted local presence: a retained blob is one a storage sweep must not evict. Both are
   * idempotent per caller count — retain twice, release twice.
   */
  readonly retain: (hash: BlobHash) => void;
  readonly release: (hash: BlobHash) => void;
  /** Live refcount for one hash — what an eviction sweep consults before touching bytes. */
  readonly retained: (hash: BlobHash) => number;
  /** Whether this device already holds the bytes, without asking anyone. */
  readonly has: (hash: BlobHash) => Promise<boolean>;
}

export interface PutBlobOptions {
  /**
   * The partition whose byte budget a relay bills these bytes to — the one the row naming them
   * will be written in. Absent, they share the relay's budget for puts that named none.
   */
  readonly partition?: PartitionKey;
}

export interface FetchBlobOptions {
  readonly timeoutMs?: number;
  /**
   * Transfer milestones. Until chunked frames land, the honest ticks are two: `(0, undefined)`
   * when the ask leaves this device, and `(byteLength, byteLength)` when verified bytes arrive —
   * enough for a spinner-with-arrival, not yet a percentage.
   */
  readonly onProgress?: (got: number, total: number | undefined) => void;
}

export interface BlobsDeps {
  /** This device's cache; it may forget anything at any time. */
  readonly store: BlobStore;
  readonly transports: () => readonly Transport[];
}

const noCapability = (what: string) =>
  R.err(
    new NoSuchCapability({
      capability: "blobs",
      message: `no transport here can ${what} bytes out of band`,
    }),
  );

export function createBlobs(deps: BlobsDeps): Blobs {
  const { store, transports } = deps;
  const holds = new Map<string, number>();

  const fetch = async (
    hash: BlobHash,
    options: FetchBlobOptions = {},
  ): Promise<Result<Uint8Array, BlobError | NoSuchCapability>> => {
    const held = await store.get(hash);
    if (held.isOk()) {
      options.onProgress?.(held.value.byteLength, held.value.byteLength);
      return held;
    }
    const carriers = transports();
    if (carriers.length === 0) return noCapability("fetch");
    const timeoutMs = options.timeoutMs ?? 10_000;
    options.onProgress?.(0, undefined); // the ask left; nobody knows the size yet
    let silent = false;
    for (const transport of carriers) {
      const answer = await transport.blobs?.download(String(hash), { timeoutMs });
      silent ||= answer === undefined;
      if (answer === undefined || answer === BLOB_MISSING) continue;
      const verified = verifyBlob(hash, answer);
      if (verified.isErr()) return R.err(verified.error); // junk, whoever served it
      await store.putAt(hash, answer);
      options.onProgress?.(answer.byteLength, answer.byteLength);
      return verified;
    }
    return R.err(
      silent
        ? new BlobTimeout({
            hash: String(hash),
            message: "nobody reachable answered with these bytes in time",
          })
        : new BlobNotFound({
            hash: String(hash),
            message: "every peer asked said it holds no bytes under that name",
          }),
    );
  };

  return {
    put: async (bytes, options = {}) => {
      const hash = hashOf(bytes);
      const stored = await store.putAt(hash, bytes);
      if (stored.isErr()) return R.err(stored.error);
      const carriers = transports();
      if (carriers.length === 0) return noCapability("carry");
      const answers = await Promise.all(
        carriers.flatMap((t) => t.blobs?.upload(String(hash), bytes, options) ?? []),
      );
      const refused = answers.find((answer) => answer !== undefined);
      if (refused === undefined) return R.ok(hash);
      return R.err(
        new BlobQuotaExceeded({
          hash: String(hash),
          partition: refused.partition,
          limit: refused.limit,
          used: refused.used,
          message: `a relay refused these bytes: ${refused.partition ?? "the unnamed budget"} holds ${refused.used} of ${refused.limit} bytes`,
        }),
      );
    },
    fetch,
    stream: (hash, options = {}) =>
      new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const fetched = await fetch(hash, options);
          fetched.match({
            ok: (bytes) => {
              controller.enqueue(bytes);
              controller.close();
            },
            err: (failure) => controller.error(failure),
          });
        },
      }),
    retain: (hash) => void holds.set(String(hash), (holds.get(String(hash)) ?? 0) + 1),
    release: (hash) => {
      const count = holds.get(String(hash)) ?? 0;
      if (count <= 1) holds.delete(String(hash));
      else holds.set(String(hash), count - 1);
    },
    retained: (hash) => holds.get(String(hash)) ?? 0,
    has: (hash) => store.has(hash),
  };
}

export { BlobNotFound, BlobQuotaExceeded, NoSuchCapability };

/**
 * The blob surface, metered, over whichever transports can carry bytes out of band (D18).
 *
 * Assembled here rather than in the mesh because the default store is a fact about blobs: a mesh
 * given none keeps them in memory, which is the right answer for a process that has not said
 * where else they should go and the wrong one to restate at every call site.
 */
export const openBlobs = (
  tally: Parameters<typeof meterBlobs>[0],
  store: BlobStore | undefined,
  transports: () => readonly Transport[],
) => meterBlobs(tally, createBlobs({ store: store ?? memoryBlobStore(), transports }));
