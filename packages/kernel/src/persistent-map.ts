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

  /**
   * Binds `key` to `to` in the map every version of `version`'s lineage shares, without making a
   * version, when it is bound there to `from` and to nothing else. `to` must be the same entry
   * spelled differently: every version that reads it gets what it had.
   */
  static respell<K, V>(version: PersistentMap<K, V>, key: K, from: V, to: V): boolean {
    const { map } = version.#store;
    if (map.get(key) !== from) return false;
    map.set(key, to);
    return true;
  }
}

/**
 * How a {@link createPackedMap} holds the values it is not using: `pack` and `unpack` are
 * inverses, and `isPacked` tells a held form from a value.
 */
export interface Packing<V, P> {
  readonly pack: (value: V) => P;
  readonly unpack: (packed: P) => V;
  readonly isPacked: (slot: V | P) => slot is P;
  /** How many values one lineage keeps unpacked: the latest written or read, oldest packed first. */
  readonly warm: number;
}

/** What every version of one packed lineage shares. */
interface Warmth<K, V, P> {
  readonly packing: Packing<V, P>;
  /** Unpacked now: the keys whose shared slot holds the value itself, with that value. */
  readonly warm: Map<K, V>;
  /** The warm keys in the order they became warm, from `head` on: what packs first. */
  readonly order: K[];
  head: number;
}

/**
 * A persistent map that holds most of its values packed and unpacks one when it is read, so a
 * table of millions of rows costs its packed bytes and not its objects. Reads, sizes and
 * iteration answer as the unpacked map would; `get` hands back one object per key for as long as
 * the key stays warm.
 */
class PackedMap<K, V, P> implements ReadonlyMap<K, V> {
  readonly #slots: PersistentMap<K, V | P>;
  readonly #warmth: Warmth<K, V, P>;

  constructor(slots: PersistentMap<K, V | P>, warmth: Warmth<K, V, P>) {
    this.#slots = slots;
    this.#warmth = warmth;
  }

  /** This version with `key` bound to `value`; `this` is untouched. */
  with(key: K, value: V): PackedMap<K, V, P> {
    const next = new PackedMap(this.#slots.with(key, value), this.#warmth);
    next.#warm(key, value);
    return next;
  }

  /**
   * Keeps `value` unpacked, and packs the value that became warm first once there are too many: a
   * queue, not a recency list, so a write costs the same however many rows are warm.
   */
  #warm(key: K, value: V): void {
    const warmth = this.#warmth;
    const { warm, order, packing } = warmth;
    if (!warm.has(key)) order.push(key);
    warm.set(key, value);
    while (warm.size > packing.warm && warmth.head < order.length) {
      const oldest = order[warmth.head];
      warmth.head += 1;
      const held = oldest === undefined ? undefined : warm.get(oldest);
      if (oldest === undefined || held === undefined) continue;
      warm.delete(oldest);
      PersistentMap.respell(this.#slots, oldest, held, packing.pack(held));
    }
    if (warmth.head > packing.warm) {
      order.splice(0, warmth.head);
      warmth.head = 0;
    }
  }

  get(key: K): V | undefined {
    const slot = this.#slots.get(key);
    const { packing } = this.#warmth;
    if (slot === undefined) return undefined;
    if (!packing.isPacked(slot)) return slot;
    const value = packing.unpack(slot);
    if (PersistentMap.respell(this.#slots, key, slot, value)) this.#warm(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.#slots.has(key);
  }

  get size(): number {
    return this.#slots.size;
  }

  /** Unpacks as it walks and keeps nothing warm: a walk of every row is not a reason to hold them. */
  *entries(): MapIterator<[K, V]> {
    const { packing } = this.#warmth;
    for (const [key, slot] of this.#slots.entries())
      yield [key, packing.isPacked(slot) ? packing.unpack(slot) : slot];
    return undefined;
  }

  *keys(): MapIterator<K> {
    yield* this.#slots.keys();
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
 * `slots` as a persistent map whose values past `packing.warm` are held packed. A slot may already
 * be packed (bytes read back from a store); a value written through {@link withEntry} starts
 * warm, and so does every unpacked value of `slots` up to `packing.warm`, the latest kept. A map
 * this already made comes back as it is; any other is copied, so no handle to the original
 * lineage ever reads a packed slot.
 *
 * @example
 * const rows = createPackedMap(stored, { pack: encode, unpack: decode, isPacked, warm: 50_000 });
 */
export function createPackedMap<K, V, P>(
  slots: ReadonlyMap<K, V | P>,
  packing: Packing<V, P>,
): ReadonlyMap<K, V> {
  if (slots instanceof PackedMap) return slots;
  const map = new Map(slots);
  const unpacked: [K, V][] = [];
  for (const [key, slot] of map) if (!packing.isPacked(slot)) unpacked.push([key, slot]);
  const cold = Math.max(0, unpacked.length - packing.warm);
  for (const [key, value] of unpacked.slice(0, cold)) map.set(key, packing.pack(value));
  const kept = unpacked.slice(cold);
  return new PackedMap(new PersistentMap<K, V | P>({ map, epoch: 0 }), {
    packing,
    warm: new Map(kept),
    order: kept.map(([key]) => key),
    head: 0,
  });
}

/** Whether `map` came from {@link createPackedMap}. */
export const isPackedMap = <K, V>(map: ReadonlyMap<K, V>): boolean => map instanceof PackedMap;

/**
 * `map` with `key` bound to `value`, leaving `map` itself untouched — O(1) once `map` came from
 * here, and one copy the first time a plain `Map` (a decoded snapshot, a loaded table) is written.
 */
export const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> =>
  map instanceof PackedMap ? map.with(key, value) : PersistentMap.from(map).with(key, value);
