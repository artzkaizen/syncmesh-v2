import type { CellValue, ColumnName, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { Procedure } from "@syncmesh/kernel";

import { createHlcClock, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import { createEngine, type EngineOptions } from "../engine.js";
import { createMemoryEventStore } from "../store.js";

export const PEER_A = parsePeerId("a".repeat(64)).unwrap();
export const PEER_B = parsePeerId("b".repeat(64)).unwrap();
export const PEER_C = parsePeerId("c".repeat(64)).unwrap();

export const seq = (n: number) => parseSeqNum(n).unwrap();

export const procedure = (label: string): Procedure => {
  // SAFETY: test fixture; procedure naming rules arrive with the client
  return label as Procedure;
};

export const hlcAt = (ms: number) =>
  createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms) }).tick();

export const fakeClock = (start: number) => {
  let ms = start;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms) });
  return { ...clock, set: (next: number) => void (ms = next) };
};

export const table = (name: string): TableName => {
  // SAFETY: test fixture; table naming rules arrive with the schema
  return name as TableName;
};
export const key = (value: string): RowKey => {
  // SAFETY: test fixture; keys are opaque strings in the kernel
  return value as RowKey;
};
export const column = (name: string): ColumnName => {
  // SAFETY: test fixture; column naming rules arrive with the schema
  return name as ColumnName;
};
export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

export const NOTES = table("notes");
export const N1 = key("n1");

export const setup = (peerId = PEER_A, startMs = 100, extra: Partial<EngineOptions> = {}) => {
  const store = createMemoryEventStore();
  const clock = fakeClock(startMs);
  const engine = createEngine({ peerId, clock, store, ...extra });
  return { store, clock, engine };
};

export const CREATE = procedure("notes.create");
