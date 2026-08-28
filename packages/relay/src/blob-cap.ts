import type { BlobHash, BlobStore } from "@syncmesh/storage";

/**
 * A ceiling on the bytes a room's blob store holds, evicting least-recently-touched first.
 *
 * Safe in a way trimming the log is not, and for one reason: a blob's name **is** its content
 * (D18). Whoever still holds the bytes can put them back under the same hash, and the answer to
 * a fetch the room can no longer serve is `blob-missing` — a value the fetcher acts on, not a
 * hole it folds. So this evicts rather than refusing, where the log has to refuse.
 *
 * A put larger than the whole cap is kept: evicting the bytes a client just handed over would
 * make `putAt` answer `ok` for bytes that are already gone. `maxFrameBytes` is where a blob too
 * big for this room is turned away, before it is ever decoded.
 */
export function cappedBlobStore(inner: BlobStore, maxBytes: number): BlobStore {
  /** Hash to byte length, in touch order: a `Map` iterates oldest first, which is the eviction order. */
  const held = new Map<BlobHash, number>();
  let total = 0;

  const touch = (hash: BlobHash, bytes: number): void => {
    const known = held.get(hash);
    if (known !== undefined) total -= known;
    held.delete(hash); // re-inserting is what moves it to the young end
    held.set(hash, bytes);
    total += bytes;
  };

  const forget = (hash: BlobHash): void => {
    const known = held.get(hash);
    if (known === undefined) return;
    total -= known;
    held.delete(hash);
  };

  /** Chosen, and not yet gone from the inner store: a read landing here must not count as a touch. */
  const dropping = new Set<BlobHash>();

  /**
   * Chosen in one synchronous pass and only then deleted: an `await` inside the walk would let a
   * put that lands mid-eviction be counted, reached and dropped in the same pass it arrived in.
   *
   * The loop that deletes still yields, though, and a `get` landing between two deletes would
   * find bytes the inner store has not lost yet and `touch` them back into the ledger — where the
   * delete behind it would leave them counted and unservable. `dropping` is what makes the two
   * halves of a removal one decision.
   */
  const evict = async (keep: BlobHash): Promise<void> => {
    const dropped: BlobHash[] = [];
    for (const [hash, size] of held) {
      if (total <= maxBytes) break;
      if (hash === keep) continue;
      total -= size;
      held.delete(hash);
      dropping.add(hash);
      dropped.push(hash);
    }
    for (const hash of dropped) {
      await inner.delete(hash);
      dropping.delete(hash);
    }
  };

  return {
    put: async (bytes) => {
      const stored = await inner.put(bytes);
      if (stored.isOk()) {
        touch(stored.value, bytes.byteLength);
        await evict(stored.value);
      }
      return stored;
    },
    putAt: async (hash, bytes) => {
      const stored = await inner.putAt(hash, bytes);
      if (stored.isOk()) {
        touch(hash, bytes.byteLength);
        await evict(hash);
      }
      return stored;
    },
    // a read is a touch: the bytes a room is still serving are the last ones it should drop —
    // unless this pass has already decided to drop them, where counting them would leave the cap
    // holding a hash the inner store is about to lose
    get: async (hash) => {
      const found = await inner.get(hash);
      if (found.isOk() && !dropping.has(hash)) touch(hash, found.value.byteLength);
      return found;
    },
    has: (hash) => inner.has(hash),
    delete: async (hash) => {
      forget(hash);
      dropping.delete(hash);
      await inner.delete(hash);
    },
  };
}
