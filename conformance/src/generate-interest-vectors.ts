/**
 * Regenerates conformance/interest-vectors.json. Run only when the rule deliberately changes
 * (README rule 3): `bun conformance/src/generate-interest-vectors.ts`.
 *
 * What an interest is on the wire and what it may keep (D23, O13), as both runtimes must read it:
 * the one text an interest is written as whatever order the app spelled it in, what a text this
 * build cannot fully read falls back to, the scope a gated relay stamps, whether one interest
 * narrows another (a window as well as partitions), and which rows a snapshot window keeps.
 */
import type { Interest, SnapshotRow } from "@syncmesh/engine";
import type { Cell, ColumnName, Logical, PeerId, RowKey, Stamp, TableName } from "@syncmesh/kernel";

import {
  interestFrom,
  interestText,
  narrows,
  sameInterest,
  scopeFrom,
  scopeText,
  windowRows,
} from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

// SAFETY: fixed 32-byte lowercase hex, which is all a peer id is
const id = (byte: string) => byte.repeat(32) as PeerId;
const P1 = id("11");
const P2 = id("22");

/** An interest as the vectors spell it: its text, or `""` for none. */
const spell = (interest: Interest | undefined) => interestText(interest);

const spelled: readonly { readonly description: string; readonly interest?: Interest }[] = [
  { description: "no interest is no text" },
  { description: "everything", interest: {} },
  {
    description: "partitions alone keep the text they always had",
    interest: { partitions: [ACME] },
  },
  {
    description: "a window is written after the partitions, whatever order the app used",
    interest: { window: { newest: 50 }, partitions: [ACME, GLOBEX] },
  },
  { description: "a window alone", interest: { window: { newest: 5 } } },
];

const read: readonly { readonly description: string; readonly text: string }[] = [
  { description: "junk is no interest", text: "not json" },
  {
    description: "a window of none is no window",
    text: '{"partitions":["org:acme"],"window":{"newest":0}}',
  },
  { description: "a fractional window is no window", text: '{"window":{"newest":2.5}}' },
  { description: "a window that is not an object is no window", text: '{"window":"lots"}' },
  {
    description: "a whole number written with a point is that number",
    text: '{"window":{"newest":7.0}}',
  },
  {
    description: "a field this build does not know is dropped",
    text: '{"partitions":[],"rank":1}',
  },
];

const scopes: readonly {
  readonly description: string;
  readonly interest?: Interest;
  readonly entitlement?: string;
}[] = [
  {
    description: "an interest-only scope is the interest's text",
    interest: { partitions: [ACME] },
  },
  {
    description: "an entitlement follows the window",
    interest: { partitions: [ACME], window: { newest: 50 } },
    entitlement: "clinic:a",
  },
  { description: "no interest beside an entitlement reads back as none", entitlement: "clinic:a" },
  {
    description: "a window alone beside an entitlement is an interest",
    interest: { window: { newest: 5 } },
    entitlement: "clinic:a",
  },
];

const acme = (newest?: number): Interest =>
  newest === undefined ? { partitions: [ACME] } : { partitions: [ACME], window: { newest } };

const pairs: readonly {
  readonly description: string;
  readonly next?: Interest;
  readonly previous?: Interest;
}[] = [
  { description: "an unscoped cursor survives anything", next: acme(5) },
  { description: "everything again over a slice widens", previous: acme() },
  {
    description: "dropping a partition narrows",
    next: acme(),
    previous: { partitions: [ACME, GLOBEX] },
  },
  {
    description: "adding a partition widens",
    next: { partitions: [ACME, GLOBEX] },
    previous: acme(),
  },
  { description: "a smaller window narrows", next: acme(50), previous: acme(100) },
  { description: "the same window narrows", next: acme(50), previous: acme(50) },
  { description: "windowing an unwindowed slice narrows", next: acme(50), previous: acme() },
  { description: "dropping the window widens", next: acme(), previous: acme(50) },
  { description: "growing the window widens", next: acme(100), previous: acme(50) },
  {
    description: "everything over a window alone widens",
    next: {},
    previous: { window: { newest: 5 } },
  },
  {
    description: "the same window in another partition order",
    next: { window: { newest: 5 }, partitions: [GLOBEX, ACME] },
    previous: { partitions: [ACME, GLOBEX], window: { newest: 5 } },
  },
];

type At = readonly [ms: number, logical: number, peer: PeerId];

interface RowSpec {
  readonly table: string;
  readonly key: string;
  readonly write?: At;
  readonly delete?: At;
  /** One cell, whose stamp may be newer than the write's. */
  readonly cell?: At;
}

const rows: readonly RowSpec[] = [
  { table: "notes", key: "a", write: [1000, 0, P1] },
  { table: "tasks", key: "a", write: [1000, 0, P1] },
  { table: "notes", key: "b", write: [1000, 0, P1] },
  { table: "notes", key: "c", write: [900, 0, P1], cell: [2000, 0, P2] },
  { table: "notes", key: "d", write: [1500, 0, P1], delete: [1600, 0, P1] },
  { table: "notes", key: "e", write: [1700, 0, P1], delete: [1200, 0, P1] },
  { table: "notes", key: "f", write: [1000, 1, P1] },
  { table: "notes", key: "g", write: [1000, 0, P2] },
  { table: "notes", key: "\u{10000}", write: [800, 0, P1] },
  { table: "notes", key: "\u{E000}", write: [800, 0, P1] },
  { table: "notes", key: "h", delete: [100, 0, P1] },
];

// SAFETY: every number written above is a non-negative integer, which is all a logical counter is
const stamp = ([ms, logical, peer]: At): Stamp => ({
  hlc: [Temporal.Instant.fromEpochMilliseconds(ms), logical as Logical],
  peer,
});

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- vector fixtures; table, key and column names are brands over these strings */
const row = (spec: RowSpec): SnapshotRow => ({
  table: spec.table as TableName,
  key: spec.key as RowKey,
  record: {
    cells: new Map<ColumnName, Cell>(
      spec.cell === undefined
        ? []
        : [["body" as ColumnName, { value: "x", stamp: stamp(spec.cell) }]],
    ),
    ...(spec.write !== undefined && { writeStamp: stamp(spec.write) }),
    ...(spec.delete !== undefined && { deleteStamp: stamp(spec.delete) }),
  },
});
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export function interestVectors() {
  const built = rows.map(row);
  return {
    texts: spelled.map(({ description, interest }) => ({
      description,
      interest: interest === undefined ? null : interest,
      text: spell(interest),
    })),
    read: read.map(({ description, text }) => ({
      description,
      text,
      reads: spell(interestFrom(text)),
    })),
    scopes: scopes.map(({ description, interest, entitlement }) => {
      const text = scopeText(interest, entitlement);
      const back = scopeFrom(text);
      return {
        description,
        interest: spell(interest),
        entitlement: entitlement ?? null,
        text,
        reads: { interest: spell(back.interest), entitlement: back.entitlement ?? null },
      };
    }),
    narrows: pairs.map(({ description, next, previous }) => ({
      description,
      next: spell(next),
      previous: spell(previous),
      narrows: narrows(next, previous),
      same: sameInterest(next, previous),
    })),
    windows: {
      rows,
      cases: [1, 2, 3, 5, 6, 7, 8, 100].map((newest) => ({
        newest,
        kept: windowRows(built, { newest }).map(({ table, key }) => [table, key]),
      })),
    },
  };
}

if (import.meta.main) {
  const out = new URL("../interest-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(interestVectors(), null, 2)}\n`);
}
