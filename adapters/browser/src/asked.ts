/**
 * A synchronous answer to a question whose answer is on another thread.
 *
 * `mesh.can(…)` and `mesh.syncOf(…)` return a value, not a promise, because a component asks them
 * while it renders. Over a port there is no such thing as a synchronous answer, so the first ask
 * says "not yet", the round trip fills the cache, and the subscription every caller of these two
 * already holds — `grants.onRegistered` for `can`, `onSyncChange` for `syncOf` — fires so the
 * asker asks again. That is the same shape as a grant landing and changing the answer, which is
 * what those subscriptions exist for; the tab is not learning a new way to wait.
 *
 * What it costs is one render of the pessimistic answer, and that is the right way round: a button
 * that appears a frame late is a worse bug than one that appears and then refuses.
 */
export interface Asked<T> {
  /** The cached answer, or `undefined` while the first round trip is out. */
  readonly read: (key: string, ask: () => Promise<T>) => T | undefined;
  /** Something happened that could change every answer. Drops them all and tells the listeners. */
  readonly forget: () => void;
  readonly clear: () => void;
}

export function createAsked<T>(notify: () => void): Asked<T> {
  const answers = new Map<string, T>();
  const asking = new Set<string>();

  return {
    read: (key, ask) => {
      const held = answers.get(key);
      if (held !== undefined || answers.has(key)) return held;
      if (asking.has(key)) return undefined;
      asking.add(key);
      void ask().then(
        (value) => {
          asking.delete(key);
          answers.set(key, value);
          notify();
        },
        () => void asking.delete(key),
      );
      return undefined;
    },
    forget: () => {
      if (answers.size === 0) return;
      answers.clear();
      notify();
    },
    clear: () => {
      answers.clear();
      asking.clear();
    },
  };
}
