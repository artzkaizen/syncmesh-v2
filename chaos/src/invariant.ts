import type { Entry, Fact, Violation } from "./ledger.js";

/**
 * The durability invariant: **no acknowledged event is ever absent from a converged replica.**
 *
 * Acknowledged means `mutate` returned ok — an `authored` line, carrying the event's id, author
 * and sequence. For every device and every such event, the device must hold it in one of three
 * ways: the event is in its log; or it compacted that author's run at or above the event and
 * its cursor stands past it, so its state is the copy; or it adopted state (a snapshot) whose
 * coverage reaches past it. Anything else is a violation, with one exception the caller can
 * read separately: a device that was told by a typed refusal that a source would not serve it
 * is *refused*, not silently short.
 *
 * Read from the ledger and from what each device reports of itself, never from the analyzer's
 * oracle, so the two checks can disagree.
 */

/** What one device holds at the end, in the engine's own words. */
export interface Holding {
  readonly device: string;
  /** Every synced event id in the device's log (`eventsSince` from nothing). */
  readonly ids: ReadonlySet<string>;
  /** Per full author id, the contiguous cursor (`engine.cursors()`). */
  readonly cursors: ReadonlyMap<string, number>;
  /** Per table, the digest (`engine.digest()`). */
  readonly digests: ReadonlyMap<string, string>;
}

/** An event a device lacks, and the typed refusal it was given instead. */
export interface RefusedEvent {
  readonly device: string;
  readonly eventId: string;
  readonly refusal: string;
}

export interface InvariantReport {
  /** Acknowledged events checked, times devices. */
  readonly checked: number;
  /** Of those, held through a compaction floor or adopted state rather than in the log. */
  readonly covered: number;
  readonly refused: readonly RefusedEvent[];
  readonly violations: readonly Fact<Violation>[];
}

type Floors = Map<string, Map<string, number>>;

/** Per device, per author, the highest sequence its state stands in for without the log. */
function floorsFrom(entries: readonly Entry[]): Floors {
  const floors: Floors = new Map();
  for (const entry of entries) {
    if (entry.kind !== "compacted" && entry.kind !== "covered") continue;
    const marks = entry.kind === "compacted" ? entry.floor : entry.cursors;
    const device = floors.get(entry.device) ?? new Map<string, number>();
    for (const [author, seq] of Object.entries(marks))
      device.set(author, Math.max(device.get(author) ?? 0, seq));
    floors.set(entry.device, device);
  }
  return floors;
}

/**
 * Per device, the typed refusal that still stands at the end of the run: the first one recorded
 * since its last clearing. A device that was refused and then served is held to everything again.
 */
export function standingRefusals(entries: readonly Entry[]): ReadonlyMap<string, string> {
  const refusals = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "cleared") refusals.delete(entry.device);
    if (entry.kind === "refused" && !refusals.has(entry.device))
      refusals.set(entry.device, `${entry.transport} ${entry.code}: ${entry.message}`);
  }
  return refusals;
}

/**
 * Why a device may lack what `author` wrote: the typed refusal it was given, or no way left from
 * the author to it once the relay serves nobody it refused (`reach.ts`). `undefined` when neither.
 */
const excuse = (
  refusals: ReadonlyMap<string, string>,
  why: Excuses,
  entry: { readonly device: string; readonly author: string; readonly seqNum: number },
  device: string,
): string | undefined => {
  const told = refusals.get(device);
  if (told !== undefined) return told;
  if (!why.reaches(entry.device, device))
    return `cut off: every way from ${entry.device} runs through a device the relay refused`;
  if (why.stateOnly(device, entry.author, entry.seqNum))
    return `state only: ${entry.device}'s run from here reaches this device in no log, and nothing that carries state does (gaps U52)`;
  return undefined;
};

/** What `reach.ts` knows that a device's own holding cannot say. */
export interface Excuses {
  /** Whether a write by the first device could reach the second at all. */
  readonly reaches: (from: string, to: string) => boolean;
  /** Whether what the device lacks of an author's run, up to a sequence, survives only as state. */
  readonly stateOnly: (device: string, author: string, seq: number) => boolean;
}

const NO_EXCUSES = { reaches: () => true, stateOnly: () => false } satisfies Excuses;

/** Every acknowledged event against every device that could ever have been sent it. */
export function checkHeld(
  entries: readonly Entry[],
  holdings: readonly Holding[],
  why: Excuses = NO_EXCUSES,
): InvariantReport {
  const floors = floorsFrom(entries);
  const refusals = standingRefusals(entries);
  const violations: Fact<Violation>[] = [];
  const refused: RefusedEvent[] = [];
  let checked = 0;
  let covered = 0;

  for (const entry of entries) {
    if (entry.kind !== "authored") continue;
    for (const holding of holdings) {
      checked += 1;
      if (holding.ids.has(entry.eventId)) continue;
      const cursor = holding.cursors.get(entry.author) ?? 0;
      const floor = floors.get(holding.device)?.get(entry.author) ?? 0;
      if (cursor >= entry.seqNum && floor >= entry.seqNum) {
        covered += 1;
        continue;
      }
      const refusal = excuse(refusals, why, entry, holding.device);
      if (refusal !== undefined && cursor < entry.seqNum) {
        refused.push({ device: holding.device, eventId: entry.eventId, refusal });
        continue;
      }
      violations.push({
        kind: "violation",
        check: "held",
        device: holding.device,
        detail:
          cursor >= entry.seqNum
            ? `cursor ${cursor} claims ${entry.device}'s ${entry.key} (seq ${entry.seqNum}, ${entry.eventId}) but the log lacks it and no floor covers it (floor ${floor})`
            : `lacks ${entry.device}'s ${entry.op} of ${entry.key} (seq ${entry.seqNum}, ${entry.eventId}): cursor ${cursor}, no typed refusal recorded`,
      });
    }
  }
  return { checked, covered, refused, violations };
}

/**
 * Per table, every device's digest against the one most devices hold. `skip` names devices
 * already known not to have converged — refused ones — whose digests are expected to differ.
 */
export function checkDigests(
  holdings: readonly Holding[],
  skip: ReadonlySet<string> = new Set(),
): readonly Fact<Violation>[] {
  const compared = holdings.filter((holding) => !skip.has(holding.device));
  const tables = new Set(compared.flatMap((holding) => [...holding.digests.keys()]));
  const violations: Fact<Violation>[] = [];
  for (const table of tables) {
    const tally = new Map<string, number>();
    for (const holding of compared) {
      const digest = holding.digests.get(table) ?? "<none>";
      tally.set(digest, (tally.get(digest) ?? 0) + 1);
    }
    if (tally.size <= 1) continue;
    const [reference] = [...tally].reduce((best, next) => (next[1] > best[1] ? next : best));
    for (const holding of compared) {
      const digest = holding.digests.get(table) ?? "<none>";
      if (digest !== reference)
        violations.push({
          kind: "violation",
          check: "digest",
          device: holding.device,
          detail: `table ${table}: digest ${digest}, most devices hold ${reference}`,
        });
    }
  }
  return violations;
}

/** The report as lines for `report.txt`. */
export function renderInvariant(
  report: InvariantReport,
  digests: readonly Fact<Violation>[],
): string {
  const lines = [
    `invariant: ${report.checked} event×device checks, ${report.covered} held by floor or adopted state, ${report.refused.length} refused, ${report.violations.length} violation(s); digests ${digests.length === 0 ? "agree" : `disagree on ${digests.length}`}`,
  ];
  const byDevice = new Map<string, number>();
  for (const refusal of report.refused)
    byDevice.set(refusal.device, (byDevice.get(refusal.device) ?? 0) + 1);
  for (const [device, count] of byDevice) {
    const first = report.refused.find((refusal) => refusal.device === device);
    lines.push(`  ${device} refused, short ${count} event(s): ${first?.refusal ?? ""}`);
  }
  for (const violation of [...report.violations, ...digests].slice(0, 40))
    lines.push(`  VIOLATION ${violation.check} ${violation.device}: ${violation.detail}`);
  return lines.join("\n");
}
