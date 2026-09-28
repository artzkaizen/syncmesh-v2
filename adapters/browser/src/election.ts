/**
 * The one call of `LockManager` an election makes.
 *
 * Named as a subset rather than taken as `LockManager` for the same reason `WirePort` is a subset
 * of `Worker`: the election is then a fact about a queue, not about a browser, and a fake queue
 * in a test runner certifies exactly the sequence a real one produces. The real
 * `navigator.locks` satisfies it by structure; nothing has to be asserted.
 */
export interface Elector {
  readonly request: (
    name: string,
    options: LockOptions,
    granted: (lock: Lock | null) => Promise<void> | undefined,
  ) => Promise<void>;
}

/** What a page asks its own dedicated worker over the worker's own `postMessage`. */
export type Control =
  | { readonly kind: "contend"; readonly lock: string }
  | { readonly kind: "serve" };

/**
 * What the worker answers with, and the order is the contract: `role` first, always, and
 * `elected` only ever after a `role` carrying `false`.
 */
export type Standing =
  | { readonly kind: "role"; readonly leader: boolean }
  | { readonly kind: "elected" }
  | { readonly kind: "unelectable" };

/**
 * Held for the life of this context.
 *
 * A Web Lock lives exactly as long as the promise its callback returned, so a promise that never
 * settles is a lock held until the context dies — and the browser releasing it then, without
 * being asked, is most of why this beats a hand-rolled election: no heartbeat, no lease expiry,
 * no stale-lock recovery, and no window in which a dead tab is still the leader.
 */
const forever = () => new Promise<void>(() => undefined);

/**
 * Contends for `name` and reports this context's standing, now and if it changes.
 *
 * Two requests, in sequence, and the sequence is what makes the answer unambiguous.
 * `ifAvailable` asks whether the lock is free **right now** and answers `null` instead of
 * queueing, so a tab learns it is a follower in one turn rather than by waiting for a leader that
 * may never leave. Only once that answer is out does the queued request go in — which is what
 * makes `role` before `elected` a guarantee rather than a race. Doing it the other way round
 * lets a leader that quits in the gap deliver `elected` to a tab that has not yet been told it is
 * a follower.
 *
 * The grant is never released here. Exactly one holder means exactly one host, and the holder
 * stops being one by dying, which is the only event a follower needs to wait for.
 *
 * @example
 * elect(navigator.locks, "syncmesh-mesh:/syncmesh", (standing) => postMessage(standing));
 */
export function elect(locks: Elector, name: string, tell: (standing: Standing) => void): void {
  void locks.request(name, { ifAvailable: true }, (lock) => {
    if (lock !== null) {
      tell({ kind: "role", leader: true });
      return forever();
    }
    tell({ kind: "role", leader: false });
    void locks.request(name, {}, (queued) => {
      if (queued === null) return undefined;
      tell({ kind: "elected" });
      return forever();
    });
    return undefined;
  });
}
