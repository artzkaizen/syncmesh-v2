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
