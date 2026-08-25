import type { SyncEvent } from "@syncmesh/kernel";

import {
  createHlcClock,
  eventId,
  parsePeerId,
  parseSeqNum,
  type CellValue,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), n: t.integer() } } },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const AUTHOR = parsePeerId("b".repeat(64)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; naming rules are not under test */
const NOTES = "notes" as TableName;
const PROC = "notes.insert" as Procedure;
const cells = (id: string, n: number) =>
  new Map<ColumnName, CellValue>([
    ["id" as ColumnName, id],
    ["n" as ColumnName, n],
  ]);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const catchUp = (count: number): SyncEvent[] => {
  const clock = createHlcClock({ now: () => T0 });
  const events: SyncEvent[] = [];
  for (let i = 1; i <= count; i += 1) {
    const seqNum = parseSeqNum(i).unwrap();
    events.push({
      v: 1,
      id: eventId(AUTHOR, seqNum),
      peerId: AUTHOR,
      seqNum,
      hlc: clock.tick(),
      procedure: PROC,
      // SAFETY: keys are opaque strings in the kernel
      changes: [{ kind: "insert", table: NOTES, key: `k${i}` as RowKey, row: cells(`k${i}`, i) }],
    });
  }
  return events;
};

describe("one fold batch is one notification, whatever it carries", () => {
  test("200 open queries, a 5,000-event catch-up, at most one notification each", async () => {
    const mesh = createMesh({
      schema: schema(),
      identity: device,
      isAuthority: true,
      now: () => T0,
    });
    const notified = new Map<number, number>();
    const handles = Array.from({ length: 200 }, (_, i) => {
      const handle = mesh.liveQuery(mesh.notes.list({ where: (row) => row.n % 200 === i }));
      handle.subscribe(() => void notified.set(i, (notified.get(i) ?? 0) + 1));
      return handle;
    });
    expect(mesh.openQueries()).toBe(200);

    const report = (
      await mesh.engine.receiveBatch(catchUp(5_000).map((event) => ({ event })))
    ).unwrap();
    expect(report.folded).toBe(5_000);
    expect(notified.size).toBe(200);
    for (const count of notified.values()) expect(count).toBe(1);
    expect(handles[7]?.data()).toHaveLength(25);
    for (const handle of handles) mesh.releaseQuery(handle);
    expect(mesh.openQueries()).toBe(0);
  });
});
