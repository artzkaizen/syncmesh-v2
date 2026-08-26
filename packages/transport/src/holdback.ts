import type { Engine, StoredEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

/** Out-of-order holdback, per author: the gap rule. Max-based cursors would jump a lost frame. */
export function createHoldback(engine: Engine, self: PeerId, gapLimit: number) {
  const held = new Map<PeerId, Map<number, StoredEvent>>();
  const contiguous = (author: PeerId): number => Number(engine.coverage().synced.get(author) ?? 0);

  return {
    /** Buffers the entry; `true` when the buffer overflowed and a resync must take over. */
    put: ({ event, sig }: StoredEvent): boolean => {
      const seq = Number(event.seqNum);
      if (event.peerId === self || seq <= contiguous(event.peerId)) return false;
      const buffer = held.get(event.peerId) ?? new Map<number, StoredEvent>();
      buffer.set(seq, sig === undefined ? { event } : { event, sig });
      held.set(event.peerId, buffer);
      if (buffer.size > gapLimit) {
        buffer.clear();
        return true;
      }
      return false;
    },
    /** The contiguous run above what the engine holds, in order. */
    drain: (author: PeerId): readonly StoredEvent[] => {
      const buffer = held.get(author);
      if (buffer === undefined) return [];
      const ready: StoredEvent[] = [];
      let next = contiguous(author) + 1;
      for (;;) {
        const entry = buffer.get(next);
        if (entry === undefined) break;
        buffer.delete(next);
        ready.push(entry);
        next += 1;
      }
      if (buffer.size === 0) held.delete(author);
      return ready;
    },
  };
}
