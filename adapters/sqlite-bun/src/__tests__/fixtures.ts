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
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

export const A = parsePeerId("a".repeat(64)).unwrap();
export const B = parsePeerId("b".repeat(64)).unwrap();

export const seq = (n: number) => parseSeqNum(n).unwrap();

// SAFETY: test fixture; the kernel's naming rules are not under test here
const PROC = "notes.create" as Procedure;
// SAFETY: as above
const NOTES = "notes" as TableName;
// SAFETY: as above
const N1 = "n1" as RowKey;

const row = (values: Readonly<Record<string, CellValue>>): Row =>
  // SAFETY: test fixture; column naming rules are not under test here
  new Map(Object.entries(values).map(([name, value]) => [name as ColumnName, value]));

export const hlc = (ms: number, logical = 0): Hlc => [
  Temporal.Instant.fromEpochMilliseconds(ms),
  // SAFETY: test fixture; a small non-negative integer is a valid Logical
  logical as Logical,
];

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
  const seqNum = parseSeqNum(n).unwrap();
  return {
    v: 1,
    id: eventId(peerId, seqNum),
    peerId,
    seqNum,
    hlc: hlc(ms),
    procedure: PROC,
    changes: [{ kind: "insert", table: NOTES, key: N1, row: row({ body: `${n}` }) }],
    ...options,
  };
};
