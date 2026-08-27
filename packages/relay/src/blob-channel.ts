import { blobGetFrame, blobPutFrame } from "./frames.js";

/**
 * The blob capability over one relay connection (D18): a put offers bytes under their own hash,
 * a fetch asks for them and waits for the answer that names the same hash — the bytes, a
 * `blob-missing`, or the deadline, whichever arrives first.
 */
export function createBlobChannel(send: (frame: Uint8Array) => void) {
  /** Fetches in flight, by hash; the relay answers each exactly once. */
  const waiting = new Map<string, (answer: Uint8Array | undefined) => void>();
  return {
    put: (hash: string, bytes: Uint8Array): Promise<void> => {
      // the relay verifies before it stores; a put that cannot leave is the caller's to retry
      send(blobPutFrame(hash, bytes));
      return Promise.resolve();
    },
    fetch: (hash: string, timeoutMs: number): Promise<Uint8Array | undefined> =>
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
    answer: (hash: string, bytes: Uint8Array | undefined): void => {
      const settle = waiting.get(hash);
      waiting.delete(hash);
      settle?.(bytes);
    },
  };
}
