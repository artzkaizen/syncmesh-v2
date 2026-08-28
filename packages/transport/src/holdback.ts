import type { Engine, StoredEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

/** Out-of-order holdback, per author: the gap rule. Max-based cursors would jump a lost frame. */
export function createHoldback(engine: Engine, self: PeerId, gapLimit: number) {
  const held = new Map<PeerId, Map<number, StoredEvent>>();
  /**
   * How far this device **holds** an author's run without a hole: its contiguous cursor, then
   * every sequence above it `engine.holding()` names — folded past a gap, or parked below one (D13).
   *
   * The cursor alone is not that number. A parked event is held but never folded, so the cursor
   * stops below it for as long as the quarantine keeps it — which for a refusal no upgrade
   * reverses is forever. Draining from the cursor would hold back every later event from that
   * author permanently, overflow into a rejoin, and re-page the same run on every reconnect. The
   * cursor still stops below it on the wire, so peers keep offering the event itself.
   */
  const through = (author: PeerId): number => {
    let at = Number(engine.coverage().synced.get(author) ?? 0);
    const ahead = new Set((engine.holding().get(author) ?? []).map(Number));
    while (ahead.has(at + 1)) at += 1;
    return at;
  };

  return {
    /** Buffers the entry; `true` when the buffer overflowed and a resync must take over. */
    put: ({ event, core, sig }: StoredEvent): boolean => {
      const seq = Number(event.seqNum);
      if (event.peerId === self || seq <= through(event.peerId)) return false;
      const buffer = held.get(event.peerId) ?? new Map<number, StoredEvent>();
      // the three fields a store keeps, and not the envelope they arrived in: a `VerifiedEvent`
      // carries `wire` as well, and holding that would keep every buffered event's bytes twice
      buffer.set(seq, { event, core, sig });
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
      let next = through(author) + 1;
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
