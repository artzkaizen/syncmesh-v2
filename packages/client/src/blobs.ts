import type { Result } from "@syncmesh/result";
import type { BlobError, BlobHash, BlobStore } from "@syncmesh/storage";
import type { Transport } from "@syncmesh/transport";

import { Result as R, TaggedError } from "@syncmesh/result";
import { BlobNotFound, BlobTimeout, hashOf, verifyBlob } from "@syncmesh/storage";

/** No transport here can carry bytes out of band — a fact about the medium, not a bug (D12). */
export class NoSuchCapability extends TaggedError("NoSuchCapability")<{
  capability: string;
  message: string;
}> {}

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
    options?: { readonly timeoutMs?: number },
  ) => Promise<Result<Uint8Array, BlobError | NoSuchCapability>>;
  /** Whether this device already holds the bytes, without asking anyone. */
  readonly has: (hash: BlobHash) => Promise<boolean>;
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
    fetch: async (hash, options = {}) => {
      const held = await store.get(hash);
      if (held.isOk()) return held;
      const carriers = transports();
      if (carriers.length === 0) return noCapability("fetch");
      const timeoutMs = options.timeoutMs ?? 10_000;
      for (const transport of carriers) {
        const answer = await transport.fetchBlob?.(String(hash), timeoutMs);
        if (answer === undefined) continue;
        const verified = verifyBlob(hash, answer);
        if (verified.isErr()) return R.err(verified.error); // junk, whoever served it
        await store.putAt(hash, answer);
        return verified;
      }
      return R.err(
        new BlobTimeout({
          hash: String(hash),
          message: "nobody reachable answered with these bytes in time",
        }),
      );
    },
    has: (hash) => store.has(hash),
  };
}

export { BlobNotFound };
