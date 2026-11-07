/**
 * One answer per request id (E-A: request ids).
 *
 * A client that timed out does not know whether its call ran, and the honest thing to do is ask
 * again under the **same id** — which the server answers from what it kept rather than by running
 * the body twice. The id rides in `x-syncmesh-request-id`; a call without one is answered fresh
 * every time, because nothing said it was the same call.
 */

/** The header a request id rides in, on the way to a handler and out of a link. */
export const REQUEST_ID_HEADER = "x-syncmesh-request-id";

/** A response as it is kept: enough to answer the same request again, byte for byte. */
export interface StoredAnswer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

/** Where a handler keeps answers by request id — memory here, a table where restarts must agree. */
export interface IdempotencyStore {
  readonly get: (id: string) => Promise<StoredAnswer | undefined>;
  readonly put: (id: string, answer: StoredAnswer) => Promise<void>;
}

/**
 * Answers kept in memory, newest last, the oldest forgotten past `capacity`. What a handler uses
 * when told nothing: enough for a retry after a timeout, and gone with the process — a restart
 * answers a retried call fresh, which is the same as having no store at all, never worse.
 */
export function memoryIdempotency(capacity = 1024): IdempotencyStore {
  const kept = new Map<string, StoredAnswer>();
  return {
    get: (id) => Promise.resolve(kept.get(id)),
    put: (id, answer) => {
      kept.set(id, answer);
      while (kept.size > capacity) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
      return Promise.resolve();
    },
  };
}
