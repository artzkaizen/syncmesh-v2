import type { Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum, TableName } from "@syncmesh/kernel";

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

/** Whether two peers have folded exactly the same events — the only state in which rows may be compared. */
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
 * Their fingerprints against ours, or `undefined` when the comparison would mean nothing. Two
 * conditions, and both are the point of the feature: the same **slice**, or we are counting
 * different rows on purpose; and the same **events folded**, or one of us is simply behind and
 * every catch-up would look like divergence (E13, E16, RFC-0014).
 */
export function divergenceAgainst(
  engine: Engine,
  interest: Interest | undefined,
  scope: string,
  theirs: {
    readonly scope: string;
    readonly at: ReadonlyMap<PeerId, SeqNum>;
    readonly digests: ReadonlyMap<string, bigint>;
  },
): readonly TableName[] | undefined {
  if (theirs.scope !== scope) return undefined;
  if (!sameCoverage(engine.coverage().synced, theirs.at)) return undefined;
  return disagreements(tableNames(engine.digest(interest)), theirs.digests);
}
