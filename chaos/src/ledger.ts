import type { PeerId, Stamp } from "@syncmesh/kernel";

/**
 * Everything that happened, in the order it happened, as one file.
 *
 * A run either converges or it does not, and "it did not" is the least useful thing a harness can
 * say. What answers the question is the sequence: which device authored an event, which links were
 * up when it did, where it went, where it stopped, and what each device believed afterwards. A
 * pass/fail tells you a bug exists; this tells you where it lives.
 *
 * One line per fact, JSON per line, appended as it happens rather than assembled at the end — a
 * run that hangs or crashes still leaves the half that ran, which is usually the interesting half.
 */

/** Monotonic across the whole run, so two devices' lines have one order to read them in. */
export type Seq = number & { readonly __brand: "chaos-seq" };

interface Base {
  readonly seq: Seq;
  /** Milliseconds since the run started, for reading rate rather than for ordering. */
  readonly ms: number;
}

/** A device wrote something. `stamp` is what the engine gave it, not what the schedule asked for. */
export interface Authored extends Base {
  readonly kind: "authored";
  readonly device: string;
  readonly table: string;
  readonly key: string;
  readonly op: "insert" | "update" | "delete";
  readonly values: Readonly<Record<string, string>>;
  readonly stamp: string;
  readonly eventId: string;
}

/** A write the device itself refused — its own policy, before anything left the machine. */
export interface Rejected extends Base {
  readonly kind: "rejected";
  readonly device: string;
  readonly table: string;
  readonly key: string;
  readonly reason: string;
}

/** A link changed state. The `why` is the schedule's word for it, so a log reads as a story. */
export interface Link extends Base {
  readonly kind: "link";
  readonly device: string;
  readonly transport: string;
  readonly up: boolean;
  readonly why: string;
}

/** A device folded events from a peer. The count is what moved, not what was offered. */
export interface Folded extends Base {
  readonly kind: "folded";
  readonly device: string;
  readonly count: number;
  readonly source: string;
}

/** A device refused an event. The pair `author#seqNum` is what to grep the rest of the file for. */
export interface Quarantined extends Base {
  readonly kind: "quarantined";
  readonly device: string;
  readonly author: string;
  readonly seqNum: number;
  readonly reason: string;
}

/** What a device holds now: its cursor per author, and a digest per table. */
export interface Snapshot extends Base {
  readonly kind: "snapshot";
  readonly device: string;
  readonly cursors: Readonly<Record<string, number>>;
  readonly digests: Readonly<Record<string, string>>;
  readonly quarantined: number;
}

/** The schedule said so — a phase boundary, worth having in the file to read it by. */
export interface Note extends Base {
  readonly kind: "note";
  readonly text: string;
}

export type Entry = Authored | Rejected | Link | Folded | Quarantined | Snapshot | Note;

/** One entry as a caller hands it over: every field but the two the ledger stamps on. */
export type Fact<E = Entry> = E extends Entry ? Omit<E, "seq" | "ms"> : never;

export interface Ledger {
  /** Appends one fact, stamped with the next sequence number and the elapsed millisecond. */
  readonly write: (fact: Fact) => void;
  readonly entries: () => readonly Entry[];
  /** The whole run as JSONL, for the file and for a later `analyze`. */
  readonly text: () => string;
}

export function createLedger(startedAt = Date.now()): Ledger {
  const entries: Entry[] = [];
  let next = 0;
  return {
    write: (fact) => {
      next += 1;
      // SAFETY: `Fact` is `Entry` minus the two fields added right here, so restoring them restores the variant the caller passed — the spread cannot produce a shape outside the union
      entries.push({ ...fact, seq: next as Seq, ms: Date.now() - startedAt } as Entry);
    },
    entries: () => entries,
    text: () => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  };
}

/**
 * A stamp as one token that sorts the way the engine orders stamps.
 *
 * Written as a key rather than as the object, because the analyzer reads the file back and a
 * `Temporal.Instant` does not survive JSON — and an analyzer that re-implements the comparison is
 * an oracle that can be wrong in its own direction. Instant, then the logical counter, then the
 * peer, each zero-padded so text order is stamp order: exactly what `compareStamp` compares.
 */
export const stampText = (stamp: Stamp): string => {
  const nanos = stamp.hlc[0].epochNanoseconds.toString().padStart(24, "0");
  const logical = `${stamp.hlc[1]}`.padStart(12, "0");
  return `${nanos}.${logical}.${stamp.peer}`;
};

/** The short form used everywhere a peer id appears in the log. */
export const short = (peer: PeerId | string): string => peer.slice(0, 8);
