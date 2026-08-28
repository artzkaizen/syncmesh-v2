import type { Ahead, Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, TableName } from "@syncmesh/kernel";

import { sameAhead } from "@syncmesh/engine";

/** What a digest exchange found: the tables that differ, and the slice both sides counted. */
export interface Divergence {
  readonly peer: PeerId;
  readonly scope: string;
  readonly tables: readonly TableName[];
}

/** The tables whose fingerprints differ, once the comparison is known to mean something. */
const disagreements = (
  ours: ReadonlyMap<string, bigint>,
  theirs: ReadonlyMap<string, bigint>,
): readonly TableName[] => {
  const names = new Set([...ours.keys(), ...theirs.keys()]);
  const differing = [...names].filter((name) => ours.get(name) !== theirs.get(name)).sort();
  // SAFETY: these are the table names both sides just exchanged, brands over those same strings
  return differing as TableName[];
};

/** Whether two peers stand at the same contiguous position; half of "the same events folded". */
const sameCoverage = (
  ours: ReadonlyMap<PeerId, SeqNum>,
  theirs: ReadonlyMap<PeerId, SeqNum>,
): boolean => {
  const authors = new Set([...ours.keys(), ...theirs.keys()]);
  for (const author of authors) {
    if (Number(ours.get(author) ?? 0) !== Number(theirs.get(author) ?? 0)) return false;
  }
  return true;
};

/** The digest map keyed by plain names, which is what the frame carries. */
export const tableNames = (digests: ReadonlyMap<TableName, bigint>): ReadonlyMap<string, bigint> =>
  new Map([...digests].map(([table, digest]) => [String(table), digest]));

/**
 * Their fingerprints against ours, or `undefined` when the comparison would mean nothing. Three
 * conditions, and each is the point of the feature: the same **slice**, or we are counting
 * different rows on purpose; the same **cursors**; and the same events held **above** them, or one
 * of us is simply one fold ahead and every catch-up would look like divergence (E13, E16, D13).
 *
 * The third is not redundant with the second. Contiguous cursors made "same cursor" weaker than
 * "same events folded": a peer holding an event past a gap, or parking one below it, stands at the
 * same number with a different set of rows. A frame that carries no `ahead` at all is therefore
 * not comparable either — an older build's silence is not a claim that it holds nothing.
 */
export function divergenceAgainst(
  engine: Engine,
  interest: Interest | undefined,
  scope: string,
  theirs: {
    readonly scope: string;
    readonly at: ReadonlyMap<PeerId, SeqNum>;
    readonly digests: ReadonlyMap<string, bigint>;
    readonly ahead?: Ahead;
  },
): readonly TableName[] | undefined {
  if (theirs.scope !== scope) return undefined;
  if (!sameCoverage(engine.coverage().synced, theirs.at)) return undefined;
  if (theirs.ahead === undefined || !sameAhead(engine.ahead(), theirs.ahead)) return undefined;
  return disagreements(tableNames(engine.digest(interest)), theirs.digests);
}
