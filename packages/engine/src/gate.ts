import type { AtomicStores, EngineOptions } from "./options.js";

/**
 * Turns on the engine's stores: writes share them, and a purge (D45) has them alone.
 *
 * A write reads the in-memory state and folds into it across awaits; so does a purge, which drops
 * and rebuilds rows from what it read. A write landing inside a purge would be rebuilt away.
 * Writes do not wait for one another — only a purge waits, for the writes already running, and
 * the writes started after it wait for it.
 */
export interface Gate {
  /** Runs `fn` beside other shared turns, after any exclusive turn queued before it. */
  readonly shared: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Runs `fn` once every turn queued before it is done, and before any queued after it. */
  readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
}

const settle = (): undefined => undefined;

/** A {@link Gate} with nothing running. A turn must not take a second turn: it would wait for itself. */
export function createGate(): Gate {
  const running = new Set<Promise<unknown>>();
  let tail = Promise.resolve();
  let queued = 0;

  const track = <T>(turn: Promise<T>): Promise<T> => {
    running.add(turn);
    const done = () => void running.delete(turn);
    turn.then(done, done);
    return turn;
  };

  return {
    shared: (fn) => (queued === 0 ? track(fn()) : tail.then(() => track(fn()))),
    exclusive: (fn) => {
      queued += 1;
      const turn = tail
        .then(async () => {
          await Promise.allSettled(running);
          return fn();
        })
        .finally(() => (queued -= 1));
      tail = turn.then(settle, settle);
      return turn;
    },
  };
}

/** A transaction over the engine's stores: what the `atomic` option is, and what a turn runs. */
type Transaction = NonNullable<EngineOptions["atomic"]>;

/** A transaction on a connection the engine does not own: what a captured write runs in without `atomic`. */
export type OuterTransaction = <T>(fn: () => Promise<T>) => Promise<T>;

/** {@link Transaction}, run inside `outer` when the engine has no `atomic` of its own. */
type SharedTransaction = <T>(
  fn: (scoped: AtomicStores) => Promise<T>,
  outer?: OuterTransaction,
) => Promise<T>;

/**
 * The engine's transaction behind one {@link Gate}: `shared` for writes, `exclusive` for a purge,
 * so no fold lands inside a purge's rebuild (D45). Without `atomic`, each runs on the plain stores.
 * `turn` is a shared turn with no transaction, for a snapshot install's or a repair's persist: they
 * write the state store outside `atomic`, but a purge must not drop rows between their writes.
 */
export function gatedTransactions(
  atomic: EngineOptions["atomic"],
  plain: AtomicStores,
  within: (scoped: AtomicStores) => AtomicStores,
) {
  const gate = createGate();
  const transaction = ((fn, outer?) => {
    if (atomic !== undefined) return atomic((scoped) => fn(within(scoped)));
    return outer === undefined ? fn(plain) : outer(() => fn(plain));
  }) satisfies SharedTransaction;
  return {
    turn: gate.shared,
    shared: ((fn, outer?) => gate.shared(() => transaction(fn, outer))) satisfies SharedTransaction,
    exclusive: ((fn) => gate.exclusive(() => transaction(fn))) satisfies Transaction,
  };
}
