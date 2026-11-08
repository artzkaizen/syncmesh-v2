import type { Coverage, StoredEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import type { SqlRow } from "./driver.js";

/**
 * A run of one author's sequence numbers, in one scope, that a read of the log did not return.
 *
 * Either the log was written without them — a scoped catch-up that filtered them out (D23), a
 * withheld run (D40), a snapshot join, an event parked or not yet delivered — and the gap table
 * says so, or a damaged page took them (D39).
 */
export interface Hole {
  readonly peer: PeerId;
  readonly local: boolean;
  readonly from: number;
  readonly to: number;
}

/** One author in one scope, as the gap table and the floors key it. */
const runKey = (peer: PeerId, local: boolean): string => `${local ? 1 : 0}:${peer}`;

/**
 * The holes in what a read returned: per author and scope, every run of sequence numbers above
 * `start` that lies below one the read did return.
 *
 * Nothing above an author's highest returned sequence is a hole here. A tear that takes an
 * author's newest events leaves no later event to show the gap; `lastSeq` refuses that page.
 */
export function readHoles(
  entries: readonly StoredEvent[],
  start: (peer: PeerId, local: boolean) => number,
): readonly Hole[] {
  const runs = new Map<string, { peer: PeerId; local: boolean; seqs: number[] }>();
  for (const { event } of entries) {
    const local = event.local === true;
    const key = runKey(event.peerId, local);
    const run = runs.get(key) ?? { peer: event.peerId, local, seqs: [] };
    run.seqs.push(event.seqNum);
    runs.set(key, run);
  }
  const holes: Hole[] = [];
  for (const { peer, local, seqs } of runs.values()) {
    let held = start(peer, local);
    for (const seq of seqs.sort((a, b) => a - b)) {
      if (seq > held + 1) holes.push({ peer, local, from: held + 1, to: seq - 1 });
      held = Math.max(held, seq);
    }
  }
  return holes;
}

/** The index of the last run starting at or below `seq`, or -1: `runs` is ordered by start. */
const lastStartingBy = (runs: readonly (readonly [number, number])[], seq: number): number => {
  let low = 0;
  let high = runs.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((runs[middle]?.[0] ?? Infinity) <= seq) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
};

/**
 * The holes neither compaction nor the gap table accounts for: what a damaged page took.
 *
 * A hole is accounted for when every sequence in it is at or below the author's compaction floor
 * or inside a recorded gap. `gaps` is the gap table's rows, `(peer, local, from, to)` ordered by
 * author and start.
 */
export function unaccounted(
  holes: readonly Hole[],
  floors: Coverage,
  gaps: readonly SqlRow[],
): readonly Hole[] {
  const recorded = new Map<string, (readonly [number, number])[]>();
  for (const [peer, local, from, to] of gaps) {
    const [author, flag] = [String(peer), Number(local)];
    const key = `${flag}:${author}`;
    const runs = recorded.get(key) ?? [];
    runs.push([Number(from), Number(to)]);
    recorded.set(key, runs);
  }
  return holes.filter(({ peer, local, from, to }) => {
    const floor = (local ? floors.local : floors.synced).get(peer) ?? 0;
    const runs = recorded.get(runKey(peer, local)) ?? [];
    let need = Math.max(from, floor + 1);
    for (let at = lastStartingBy(runs, need); at >= 0 && need <= to; at += 1) {
      const run = runs[at];
      if (run === undefined || run[0] > need) break;
      need = Math.max(need, run[1] + 1);
    }
    return need <= to;
  });
}
