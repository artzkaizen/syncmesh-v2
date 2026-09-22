import type { TransportBlobs } from "@syncmesh/transport";

import { blobGetFrame, blobPutFrame } from "./frames.js";

/**
 * The blob capability over one relay connection (D18): an upload offers bytes under their own
 * hash, a download asks for them and waits for the answer that names the same hash — the bytes,
 * a `blob-missing`, or the deadline, whichever arrives first.
 *
 * `capability` is the object the transport hands the mesh, typed as the seam so it can grow with
 * it; `answer` stays here, because an inbound frame settling a wait is the relay's business.
 */
export function createBlobChannel(send: (frame: Uint8Array) => void) {
  /** Downloads in flight, by hash; the relay answers each exactly once. */
  const waiting = new Map<string, (answer: Uint8Array | undefined) => void>();
  const capability: TransportBlobs = {
    upload: (hash, bytes) => {
      // the relay verifies before it stores; an upload that cannot leave is the caller's to retry
      send(blobPutFrame(hash, bytes));
      return Promise.resolve();
    },
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
    answer: (hash: string, bytes: Uint8Array | undefined): void => {
      const settle = waiting.get(hash);
      waiting.delete(hash);
      settle?.(bytes);
    },
  };
}
