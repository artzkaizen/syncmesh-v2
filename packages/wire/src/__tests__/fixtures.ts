import type {
  CellValue,
  Change,
  ColumnName,
  Row,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import {
  createHlcClock,
  eventId,
  parseSeqNum,
  type PartitionKey,
  type Procedure,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import { createIdentity } from "../identity.js";

export const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
export const IDENTITY_A = createIdentity(SEED_A).unwrap();
export const IDENTITY_B = createIdentity(SEED_B).unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures for brands whose rules live in later epics */
export const table = (s: string) => s as TableName;
export const key = (s: string) => s as RowKey;
export const column = (s: string) => s as ColumnName;
export const procedure = (s: string) => s as Procedure;
export const partition = (s: string) => s as PartitionKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

export const hlcAt = (ms: number) =>
  createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms) }).tick();

export const event = (
  changes: readonly Change[],
  options: { seq?: number; ms?: number; partition?: string; procedure?: string } = {},
): SyncEvent => {
  const seqNum = parseSeqNum(options.seq ?? 1).unwrap();
  const base: SyncEvent = {
    v: 1,
    id: eventId(IDENTITY_A.peerId, seqNum),
    peerId: IDENTITY_A.peerId,
    seqNum,
    hlc: hlcAt(options.ms ?? 1_700_000_000_000),
    procedure: procedure(options.procedure ?? "notes.create"),
    changes,
  };
  return options.partition === undefined
    ? base
    : { ...base, partition: partition(options.partition) };
};
