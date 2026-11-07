import type { BlobRefusal, TransportBlobs } from "@syncmesh/transport";

import { Temporal, durationMs } from "@syncmesh/temporal";
import { BLOB_MISSING } from "@syncmesh/transport";

import { blobGetFrame, blobPutFrame } from "./frames.js";

/**
 * How long an upload waits for the relay to say it kept the bytes. A relay built before
 * `blob-stored` never says, so this is also how long a put against one takes — and running out
 * is not a refusal, because silence is what that relay has always answered with.
 */
export const BLOB_ANSWER_WAIT = Temporal.Duration.from({ seconds: 10 });

/** What a relay said about one download: the bytes, or that it holds none. */
type Answer = Uint8Array | typeof BLOB_MISSING;

/**
 * The blob capability over one relay connection (D18): an upload offers bytes under their own
 * hash and waits for `blob-stored` or `blob-refused`; a download asks for them and waits for the
 * answer that names the same hash — the bytes, a `blob-missing`, or the deadline, whichever
 * arrives first.
 *
 * `capability` is the object the transport hands the mesh, typed as the seam so it can grow with
 * it; `answer` and `settle` stay here, because an inbound frame settling a wait is the relay's
 * business.
 */
export function createBlobChannel(send: (frame: Uint8Array) => void) {
  /** Downloads in flight, by hash; the relay answers each exactly once. */
  const waiting = new Map<string, (answer: Answer | undefined) => void>();
  /** Uploads in flight, by hash: two puts of one photo are two waits on one answer. */
  const uploading = new Map<string, ((refusal: BlobRefusal | undefined) => void)[]>();

  const capability: TransportBlobs = {
    upload: (hash, bytes, options = {}) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          const rest = (uploading.get(hash) ?? []).filter((wait) => wait !== settle);
          if (rest.length === 0) uploading.delete(hash);
          else uploading.set(hash, rest);
          resolve(undefined);
        }, durationMs(BLOB_ANSWER_WAIT));
        const settle = (refusal: BlobRefusal | undefined): void => {
          clearTimeout(timer);
          resolve(refusal);
        };
        uploading.set(hash, [...(uploading.get(hash) ?? []), settle]);
        // the relay verifies before it stores; an upload that cannot leave is the caller's to retry
        send(blobPutFrame(hash, bytes, options.partition));
      }),
    download: (hash, { timeoutMs }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(hash);
          resolve(undefined);
        }, timeoutMs);
        waiting.set(hash, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        send(blobGetFrame(hash));
      }),
  };
  return {
    capability,
    /** A `blob` or `blob-missing` arrived: the bytes, or `undefined` for none held there. */
    answer: (hash: string, bytes: Uint8Array | undefined): void => {
      const settle = waiting.get(hash);
      waiting.delete(hash);
      settle?.(bytes ?? BLOB_MISSING);
    },
    /** A `blob-stored` (no refusal) or `blob-refused` arrived for every upload of this hash. */
    settle: (hash: string, refusal: BlobRefusal | undefined): void => {
      const waits = uploading.get(hash) ?? [];
      uploading.delete(hash);
      for (const wait of waits) wait(refusal);
    },
  };
}
