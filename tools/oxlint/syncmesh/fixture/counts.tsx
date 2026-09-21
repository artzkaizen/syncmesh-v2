// Cases for `syncmesh/no-rendered-length` and `syncmesh/no-length-against-limit`. The repository
// lints nothing under tools/oxlint, so run this by hand from this directory:
//
//   ../../../../node_modules/.bin/oxlint --config .oxlintrc.json counts.tsx
//
// Every line under "should report" must produce one diagnostic, and nothing under
// "should NOT report" may produce any.

declare const rows: readonly { id: string }[];
declare const group: { rows: readonly { id: string }[] };
declare const LISTED: number;
declare const options: { limit: number };
declare const mediums: readonly { id: string }[];
declare const count: { value: number; kind: string };
declare const countText: (c: typeof count) => string;

export function Reported() {
  return (
    <div>
      {/* should report — a page's length presented as a number on screen */}
      {rows.length}
      {group.rows.length}
      <span>{group.rows.length}</span>
      {`${rows.length} issues`}
    </div>
  );
}

export function NotReported() {
  return (
    <div>
      {/* should NOT report — a collection assembled here is fully known, whatever its length */}
      <span>{mediums.length} peers</span>
      {/* nor a guard: it asks whether anything is here, which a page can answer honestly */}
      {rows.length === 0 ? <span>Nothing matches these filters.</span> : undefined}
      {rows.length > 0 && <span>Some</span>}
      {/* nor a count that carried its own scope */}
      {countText(count)}
      <span aria-label={String(rows.length)} />
    </div>
  );
}

export function comparisons(): readonly boolean[] {
  return [
    // should report — cannot tell a set of exactly `limit` from a set of more
    rows.length >= LISTED,
    rows.length === LISTED,
    // should NOT report — `>` is the probe done right (ask for limit + 1), `<` proves complete
    rows.length > options.limit,
    group.rows.length < options.limit,
    // nor a guard, nor a comparison against something that is not a limit at all
    rows.length === 0,
    rows.length > group.rows.length,
  ];
}
