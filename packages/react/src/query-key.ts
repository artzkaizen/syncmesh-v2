/** What a hook needs from a Drizzle query beyond running it: its SQL identity. */
export interface Keyed {
  readonly toSQL: () => { readonly sql: string; readonly params: readonly unknown[] };
}

/** A bind once Drizzle mapped it: a SQL scalar, bytes, or a Date. */
type BoundParam = string | number | bigint | boolean | Uint8Array | Date | null | undefined;

/* oxlint-disable anti-slop/no-runtime-typeof -- bigint has no instanceof; this is the bind's serialisation boundary */
const printable = (value: BoundParam): string | number | boolean | null => {
  if (value instanceof Uint8Array)
    return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return `${value}n`;
  return value ?? null;
};
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * A query's identity: its SQL and bound params. A Drizzle query is data, so two renders that
 * build the same question get the same key and share one subscription — and a changed filter is
 * a changed key, no dependency array anywhere (the Hermes `fn.toString()` trap never applies).
 */
export const queryKey = (query: Keyed): string => {
  const { sql, params } = query.toSQL();
  // SAFETY: Drizzle maps every bind to a SQL scalar, bytes or a Date before toSQL exposes it
  return JSON.stringify([sql, params.map((p) => printable(p as BoundParam))]);
};
