/**
 * A `ReadonlyMap` whose `with` returns a new version in O(1) and leaves the old one readable.
 *
 * Every version of one lineage shares a single native `Map`. The newest version — the *root* —
 * reads it directly; every other version is a one-entry diff pointing one step closer to the root.
 * Writing to the root mutates the `Map` in place and turns the old root into the diff that undoes
 * it. Reading an old version first walks the diffs back onto the `Map` ("rerooting", after Baker),
 * which costs the distance between the two versions and nothing when the caller only ever reads
 * the newest — the fold's whole pattern.
 *
 * Iteration order is exactly a native `Map`'s: a write to a held key keeps its place, a new key
 * goes last, and rerooting undoes and redoes in that same order, so whichever version is the root,
 * the shared `Map` lists that version's keys in that version's order.
 *
 * @module
 */

/** Shared by every version of one lineage. */
interface Store<K, V> {
  readonly map: Map<K, V>;
  /** Bumped on every write to `map`, so a paused iterator can tell its view moved. */
  epoch: number;
}

/** What turns `next` into this version: `key` bound to `value`, or absent from it. */
type Diff<K, V> = { readonly key: K; readonly next: PersistentMap<K, V> } & (
  | { readonly held: true; readonly value: V }
  | { readonly held: false }
);

const bindingIn = <K, V>(map: Map<K, V>, key: K, next: PersistentMap<K, V>): Diff<K, V> =>
  map.has(key)
    ? // SAFETY: `has` just said the key is bound, so `get` returns its V (which may itself be undefined)
      { key, next, held: true, value: map.get(key) as V }
    : { key, next, held: false };

const isPersistent = <K, V>(map: ReadonlyMap<K, V>): map is PersistentMap<K, V> =>
  map instanceof PersistentMap;

class PersistentMap<K, V> implements ReadonlyMap<K, V> {
  readonly #store: Store<K, V>;
  /** Absent exactly on the root: the one version the shared map currently spells. */
  #diff: Diff<K, V> | undefined;

  constructor(store: Store<K, V>) {
    this.#store = store;
  }

  static from<K, V>(entries: ReadonlyMap<K, V>): PersistentMap<K, V> {
    if (isPersistent(entries)) return entries;
    return new PersistentMap({ map: new Map(entries), epoch: 0 });
  }

  /** This version with `key` bound to `value`; `this` is untouched. */
  with(key: K, value: V): PersistentMap<K, V> {
    const map = PersistentMap.#reroot(this);
    const next = new PersistentMap(this.#store);
    this.#diff = bindingIn(map, key, next);
    map.set(key, value);
    this.#store.epoch += 1;
    return next;
  }

  /**
   * Makes `version` the root and returns the shared map, iteratively so a long-held old version
   * cannot overflow the stack.
   */
  static #reroot<K, V>(version: PersistentMap<K, V>): Map<K, V> {
    const { map } = version.#store;
    if (version.#diff === undefined) return map;
    const path: { readonly at: PersistentMap<K, V>; readonly diff: Diff<K, V> }[] = [];
    for (let at = version, diff = at.#diff; diff !== undefined; at = diff.next, diff = at.#diff)
      path.push({ at, diff });
    // from the root outward: each step hands the root's role one version closer to `version`
    for (let step = path.pop(); step !== undefined; step = path.pop()) {
      const { at, diff } = step;
      diff.next.#diff = bindingIn(map, diff.key, at);
      if (diff.held) map.set(diff.key, diff.value);
      else map.delete(diff.key);
      at.#diff = undefined;
    }
    version.#store.epoch += 1;
    return map;
  }

  get size(): number {
    return PersistentMap.#reroot(this).size;
  }

  get(key: K): V | undefined {
    return PersistentMap.#reroot(this).get(key);
  }

  has(key: K): boolean {
    return PersistentMap.#reroot(this).has(key);
  }

  /**
   * Walks this version's entries, surviving writes to any version mid-walk: when the shared map
   * moves, the walk reroots and skips what it has already yielded, which the order invariant makes
   * exact.
   */
  *entries(): MapIterator<[K, V]> {
    let yielded = 0;
    for (;;) {
      const map = PersistentMap.#reroot(this);
      const epoch = this.#store.epoch;
      let skip = yielded;
      let moved = false;
      for (const entry of map) {
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        yield entry;
        yielded += 1;
        if (this.#store.epoch !== epoch) {
          moved = true;
          break;
        }
      }
      if (!moved) return undefined;
    }
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
    return undefined;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
    return undefined;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void): void {
    for (const [key, value] of this.entries()) callback(value, key, this);
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

/**
 * `map` with `key` bound to `value`, leaving `map` itself untouched — O(1) once `map` came from
 * here, and one copy the first time a plain `Map` (a decoded snapshot, a loaded table) is written.
 */
export const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  PersistentMap.from(map).with(key, value);
