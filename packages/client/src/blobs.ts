import type { Result } from "@syncmesh/result";
import type { BlobError, BlobHash, BlobStore } from "@syncmesh/storage";
import type { Transport } from "@syncmesh/transport";

import { Result as R } from "@syncmesh/result";
import { BlobNotFound, BlobTimeout, hashOf, verifyBlob } from "@syncmesh/storage";

import { NoSuchCapability } from "./errors.js";

export interface Blobs {
  /**
   * Stores the bytes locally under their own hash and offers them to every transport that can
   * carry them. The hash is what a row then references — put first, write the row second, so a
   * peer that sees the row can already fetch what it names.
   */
  readonly put: (bytes: Uint8Array) => Promise<Result<BlobHash, BlobError | NoSuchCapability>>;
  /**
   * The bytes behind a hash: this device's cache first, then whoever can be asked. Verified on
   * arrival — a reference is a proof of content, not a promise about a server — and cached, since
   * a device's copy is an eviction candidate rather than an obligation (D18).
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
    for (const transport of carriers) {
      const answer = await transport.fetchBlob?.(String(hash), timeoutMs);
      if (answer === undefined) continue;
      const verified = verifyBlob(hash, answer);
      if (verified.isErr()) return R.err(verified.error); // junk, whoever served it
      await store.putAt(hash, answer);
      options.onProgress?.(answer.byteLength, answer.byteLength);
      return verified;
    }
    return R.err(
      new BlobTimeout({
        hash: String(hash),
        message: "nobody reachable answered with these bytes in time",
      }),
    );
  };

  return {
    put: async (bytes) => {
      const hash = hashOf(bytes);
      const stored = await store.putAt(hash, bytes);
      if (stored.isErr()) return R.err(stored.error);
      const carriers = transports();
      if (carriers.length === 0) return noCapability("carry");
      await Promise.all(carriers.flatMap((t) => t.putBlob?.(String(hash), bytes) ?? []));
      return R.ok(hash);
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

export { BlobNotFound, NoSuchCapability };
