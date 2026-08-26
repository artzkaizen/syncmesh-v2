import { useCallback, useRef, useSyncExternalStore } from "react";

/** The slice of a presence topic the hook reads — `mesh.presence("board:b1").cursor`. */
export interface PresenceTopic<P> {
  readonly peers: () => readonly P[];
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Everyone at a presence topic, as React state: re-renders when anyone's value changes or
 * expires, and not otherwise. A room of twenty moving pointers is one render per change batch,
 * because the store conflates before it notifies (D16).
 *
 * ```tsx
 * const cursors = usePresence(mesh.presence("board:b1").cursor)
 * return cursors.map((c) => <Cursor key={String(c.peerId)} at={c.value} />)
 * ```
 */
export function usePresence<P>(topic: PresenceTopic<P>): readonly P[] {
  const held = useRef<readonly P[]>([]);
  const subscribe = useCallback((notify: () => void) => topic.subscribe(notify), [topic]);
  // useSyncExternalStore compares snapshots by identity, and `peers()` builds a fresh array
  // every call: hold the last one and return it unchanged until the contents actually differ
  const snapshot = useCallback(() => {
    const next = topic.peers();
    const previous = held.current;
    if (next.length === previous.length && next.every((peer, i) => peer === previous[i]))
      return previous;
    held.current = next;
    return next;
  }, [topic]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
