/**
 * How far a question has been answered: not at all, by this device, or by everything that could.
 *
 * The words are the ones this system already uses for the same subjects. `"local"` is what a fold
 * batch calls this device writing and what a row's `SyncState` calls a write that has not left
 * yet; `"settled"` is what `mesh.settled()` resolves on. Nothing here invents a vocabulary.
 */
export type Answered = "none" | "local" | "settled";

/**
 * The one place the progression is decided, so two hooks cannot disagree about it.
 *
 * `settled` alone is not enough to reach `"settled"`, and that is the whole point: a device with
 * no transports has nothing far to wait for, so its sources settle before its own store has
 * spoken. Requiring the local read first makes that state — everything answered, nothing read —
 * impossible to write down.
 */
export const answeredFrom = (read: boolean, settled: boolean): Answered =>
  !read ? "none" : settled ? "settled" : "local";
