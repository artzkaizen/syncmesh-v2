import type { StoredEvent } from "@syncmesh/engine";
import type {
  CellValue,
  ColumnName,
  Hlc,
  Logical,
  PartitionKey,
  PeerId,
  Procedure,
  Row,
  RowKey,
  RowRecord,
  Stamp,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { t, table } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";

export const A = parsePeerId("a".repeat(64)).unwrap();
export const B = parsePeerId("b".repeat(64)).unwrap();

export const seq = (n: number) => parseSeqNum(n).unwrap();
export const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
export const NOTES = "notes" as TableName;
export const N1 = "n1" as RowKey;
export const BODY = "body" as ColumnName;
const PROCEDURE = "notes.create" as Procedure;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const hlc = (ms: number, logical = ZERO): Hlc => [at(ms), logical];

const row = (body: CellValue): Row => new Map([[BODY, body]]);

export interface EventOptions {
  readonly partition?: PartitionKey;
  readonly local?: true;
}

export const event = (
  peerId: PeerId,
  n: number,
  ms: number,
  options: EventOptions = {},
): SyncEvent => {
  const seqNum = seq(n);
  return {
    v: 1,
    id: eventId(peerId, seqNum, options.local === true),
    peerId,
    seqNum,
    hlc: hlc(ms),
    procedure: PROCEDURE,
    changes: [{ kind: "insert", table: NOTES, key: N1, row: row(`${n}`) }],
    ...options,
  };
};

export const stamp = (ms: number): Stamp => ({ hlc: hlc(ms), peer: A });

export const record = (body: string, ms: number): RowRecord => ({
  cells: new Map([[BODY, { value: body, stamp: stamp(ms) }]]),
  writeStamp: stamp(ms),
});

export const ids = (events: readonly SyncEvent[]) => events.map((e) => e.id);

/** The stored form; `sig` deterministic from the id so round-trips are checkable. */
export const entry = (
  peerId: PeerId,
  n: number,
  ms: number,
  options: EventOptions = {},
): StoredEvent => {
  const e = event(peerId, n, ms, options);
  return { event: e, sig: Uint8Array.from({ length: 8 }, (_, i) => (n + i) % 256) };
};

export const ids2 = (entries: readonly StoredEvent[]) => entries.map((x) => x.event.id);

/** A synced table with every column kind once, so each SQL encoding is exercised (capture and projection suites). */
export const JOBS = table("jobs", {
  id: t.text().primaryKey(),
  title: t.text(),
  hours: t.float().nullable(),
  rank: t.integer(),
  done: t.boolean(),
  dueAt: t.timestamp().nullable(),
  meta: t.json().nullable(),
  photo: t.blob().nullable(),
});
export const COUNTERS = table("counters", { id: t.integer().primaryKey(), n: t.integer() });
