import type { Entry } from "./ledger.js";

/**
 * What the run should have ended at, and where each device actually did.
 *
 * The oracle is derived from the authored writes in the ledger, never declared: per cell, the
 * write with the highest stamp wins, and a row deleted after its last write is gone. So the
 * expectation moves when the merge rules move, and cannot be quietly wrong in the same direction
 * as the code it is checking.
 *
 * A divergence is reported with the row's own history — who wrote it, and what each device refused
 * — because "device c is missing n3" is a question, and the answer is in the lines around it.
 */

export interface Missing {
  readonly device: string;
  readonly row: string;
  readonly column: string;
  readonly expected: string;
  readonly actual: string;
}

export interface Report {
  readonly authored: number;
  readonly rejected: number;
  readonly quarantined: number;
  readonly devices: readonly string[];
  readonly missing: readonly Missing[];
  /** Per device, what it refused and never took — the refusals that cost it rows. */
  readonly stuck: ReadonlyMap<string, readonly string[]>;
  readonly converged: boolean;
}

/** What each device holds at the end: row key, then column, then value. */
export type Held = ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, string>>>>;

/**
 * Stamps arrive from the ledger as keys built to sort in stamp order, so "later" is text order.
 * The ordering itself lives in `stampText`, next to the engine's own comparison rather than as a
 * second implementation here that could drift from it.
 */
const laterStamp = (a: string, b: string): boolean => a > b;

/** What the writes say must be true, before any device is looked at. */
interface Oracle {
  readonly cells: ReadonlyMap<string, { readonly stamp: string; readonly value: string }>;
  readonly removals: ReadonlyMap<string, string>;
  readonly lastWrite: ReadonlyMap<string, string>;
  readonly authored: number;
  readonly rejected: number;
  readonly quarantined: number;
  readonly stuck: ReadonlyMap<string, readonly string[]>;
}

/** Reads the log once and works out what should have happened, without looking at any device. */
function oracleOf(entries: readonly Entry[]): Oracle {
  const cells = new Map<string, { stamp: string; value: string }>();
  const removals = new Map<string, string>();
  const lastWrite = new Map<string, string>();
  const stuck = new Map<string, string[]>();
  let authored = 0;
  let rejected = 0;
  let quarantined = 0;

  const keepLater = (into: Map<string, string>, id: string, stamp: string) => {
    const current = into.get(id);
    if (current === undefined || laterStamp(stamp, current)) into.set(id, stamp);
  };

  for (const entry of entries) {
    if (entry.kind === "rejected") rejected += 1;
    if (entry.kind === "quarantined") {
      quarantined += 1;
      const refusals = stuck.get(entry.device) ?? [];
      refusals.push(`${entry.author}#${entry.seqNum}: ${entry.reason}`);
      stuck.set(entry.device, refusals);
    }
    if (entry.kind !== "authored") continue;
    authored += 1;
    if (entry.op === "delete") {
      keepLater(removals, entry.key, entry.stamp);
      continue;
    }
    keepLater(lastWrite, entry.key, entry.stamp);
    for (const [name, value] of Object.entries(entry.values)) {
      const id = `${entry.key} ${name}`;
      const winner = cells.get(id);
      if (winner === undefined || laterStamp(entry.stamp, winner.stamp))
        cells.set(id, { stamp: entry.stamp, value });
    }
  }
  return { cells, removals, lastWrite, authored, rejected, quarantined, stuck };
}

/** Every cell the oracle names, against what each device actually holds. */
function diff(oracle: Oracle, held: Held, devices: readonly string[]): readonly Missing[] {
  const missing: Missing[] = [];
  for (const [id, winner] of oracle.cells) {
    const [rowId, name] = id.split(" ");
    if (rowId === undefined || name === undefined) continue;
    const removed = oracle.removals.get(rowId);
    const written = oracle.lastWrite.get(rowId);
    const gone = removed !== undefined && (written === undefined || laterStamp(removed, written));
    const expected = gone ? "<absent>" : winner.value;
    for (const device of devices) {
      const actual = held.get(device)?.get(rowId)?.[name] ?? "<absent>";
      if (actual !== expected) missing.push({ device, row: rowId, column: name, expected, actual });
    }
  }
  return missing;
}

export function analyze(entries: readonly Entry[], held: Held): Report {
  const devices = [...held.keys()].sort();
  const oracle = oracleOf(entries);
  const missing = diff(oracle, held, devices);
  return {
    authored: oracle.authored,
    rejected: oracle.rejected,
    quarantined: oracle.quarantined,
    devices,
    missing,
    stuck: oracle.stuck,
    converged: missing.length === 0,
  };
}

/** The report as something worth reading in a terminal, with each divergence's own history. */
export function render(report: Report, entries: readonly Entry[]): string {
  const lines: string[] = [
    `authored ${report.authored}  rejected ${report.rejected}  quarantined ${report.quarantined}  devices ${report.devices.join(",")}`,
  ];
  if (report.converged) {
    lines.push("converged: every device holds every write");
    return lines.join("\n");
  }

  lines.push(`DIVERGED: ${report.missing.length} cell(s) disagree`);
  const byRow = new Map<string, Missing[]>();
  for (const miss of report.missing) {
    const held = byRow.get(miss.row) ?? [];
    held.push(miss);
    byRow.set(miss.row, held);
  }
  for (const [rowId, misses] of byRow) {
    lines.push("", `  ${rowId}`);
    for (const miss of misses)
      lines.push(
        `    ${miss.device}.${miss.column}: expected ${miss.expected}, holds ${miss.actual}`,
      );
    lines.push("    history:");
    for (const entry of entries) {
      if (entry.kind === "authored" && entry.key === rowId)
        lines.push(
          `      #${entry.seq} ${entry.device} ${entry.op} ${JSON.stringify(entry.values)}`,
        );
      if (entry.kind === "quarantined" && misses.some((miss) => miss.device === entry.device))
        lines.push(
          `      #${entry.seq} ${entry.device} refused ${entry.author}#${entry.seqNum}: ${entry.reason}`,
        );
    }
  }
  for (const [device, refusals] of report.stuck) {
    lines.push("", `  ${device} refused ${refusals.length}:`);
    for (const refusal of [...new Set(refusals)].slice(0, 6)) lines.push(`    ${refusal}`);
  }
  return lines.join("\n");
}
