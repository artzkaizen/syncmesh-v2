import type { PeerId, SeqNum } from "@syncmesh/kernel";

/** Every sequence of one author's run in one scope, from `from` to `to`, both included. */
export interface SeqRun {
  readonly peer: PeerId;
  /** The run is of local-only events, which never travel. */
  readonly local: boolean;
  readonly from: SeqNum;
  readonly to: SeqNum;
}

const runKey = (peer: PeerId, local: boolean): string => `${local ? 1 : 0}:${peer}`;

/**
 * Per author and scope, the runs at or below the compaction floor that the log never held when
 * compaction passed them: events withheld or scoped out of what this device was sent (D23, D40),
 * or evicted by a purge (D45). A later delivery of one of them is history this device has not
 * folded, not a compacted event come back, so `EventStore.compacted` answers `false` inside a
 * run (gaps U1).
 *
 * What the SQL log keeps in its gap table, kept here for the stores that have none.
 */
export function createFloorHoles(initial: readonly SeqRun[] = []) {
  const held = new Map<string, { peer: PeerId; local: boolean; runs: [SeqNum, SeqNum][] }>();
  const entry = (peer: PeerId, local: boolean) => {
    const key = runKey(peer, local);
    const found = held.get(key);
    if (found !== undefined) return found;
    const runs: [SeqNum, SeqNum][] = [];
    const made = { peer, local, runs };
    held.set(key, made);
    return made;
  };

  /** Records a run, merged with any it touches. */
  const add = ({ peer, local, from, to }: SeqRun): void => {
    const at = entry(peer, local);
    let [low, high] = [from, to];
    const kept: [SeqNum, SeqNum][] = [];
    for (const [start, end] of at.runs) {
      if (end + 1 < low || high + 1 < start) kept.push([start, end]);
      else [low, high] = [start < low ? start : low, end > high ? end : high];
    }
    kept.push([low, high]);
    at.runs = kept.sort(([a], [b]) => a - b);
  };
  for (const run of initial) add(run);

  return {
    add,
    /** Whether `seq` lies in a recorded run. */
    holds: (peer: PeerId, local: boolean, seq: SeqNum): boolean =>
      held.get(runKey(peer, local))?.runs.some(([from, to]) => from <= seq && seq <= to) === true,
    /** Takes `seq` out of the run that holds it: it arrived. Whether it was in one. */
    fill: (peer: PeerId, local: boolean, seq: SeqNum): boolean => {
      const at = held.get(runKey(peer, local));
      const index = at?.runs.findIndex(([from, to]) => from <= seq && seq <= to) ?? -1;
      if (at === undefined || index < 0) return false;
      const [from, to] = at.runs[index] ?? [seq, seq];
      // SAFETY: a sequence one either side of a positive one inside the run is still positive
      const split: [SeqNum, SeqNum][] = [
        ...(from < seq ? [[from, (seq - 1) as SeqNum] as [SeqNum, SeqNum]] : []),
        ...(seq < to ? [[(seq + 1) as SeqNum, to] as [SeqNum, SeqNum]] : []),
      ];
      at.runs.splice(index, 1, ...split);
      return true;
    },
    /** Every recorded run, ordered by author and start. */
    runs: (): readonly SeqRun[] =>
      [...held.values()].flatMap(({ peer, local, runs }) =>
        runs.map(([from, to]) => ({ peer, local, from, to })),
      ),
  };
}

export type FloorHoles = ReturnType<typeof createFloorHoles>;

/**
 * The runs in `(above, upTo]` that are not among `seqs`: what a compaction that raised one
 * author's floor from `above` to `upTo` passed without holding.
 *
 * @example
 * unheldRuns(a, false, [3, 4, 7], 2, 7) // [{ peer: a, local: false, from: 5, to: 6 }]
 */
export function unheldRuns(
  peer: PeerId,
  local: boolean,
  seqs: readonly SeqNum[],
  above: number,
  upTo: SeqNum,
): readonly SeqRun[] {
  const runs: SeqRun[] = [];
  let reached = above;
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    if (seq <= reached) continue;
    if (seq > upTo) break;
    if (seq > reached + 1) {
      // SAFETY: one above a count at or above zero is positive, and `seq - 1` is above `reached`
      runs.push({ peer, local, from: (reached + 1) as SeqNum, to: (seq - 1) as SeqNum });
    }
    reached = seq;
  }
  if (reached < upTo) {
    // SAFETY: one above a count at or above zero is positive
    runs.push({ peer, local, from: (reached + 1) as SeqNum, to: upTo });
  }
  return runs;
}
