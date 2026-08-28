import { describe, expect, test } from "bun:test";

import type { SourceRow, TableRead } from "../source.js";

import { startCapture } from "../capture.js";
import { manualChangeSource } from "../manual.js";
import { parseWatermark } from "../source.js";
import { storedWatermark } from "../watermark.js";
import { ACME, GLOBEX, TASKS, authority, mappings, peerAt, rowsOf, until } from "./fixtures.js";

const existing: readonly SourceRow[] = [
  { id: "t1", orgId: "acme", title: "already there", ownerId: "acct_alice" },
  { id: "t2", orgId: "acme", title: "also there", ownerId: "acct_alice" },
  { id: "t3", orgId: "globex", title: "elsewhere", ownerId: "acct_bob" },
];

const watermarkAt = (n: number) => parseWatermark(String(n).padStart(20, "0")).unwrap();

/** A database that can be read but not streamed, at a position it hands out before the read. */
const reader = (at: number, order: string[]): TableRead => ({
  watermark: () => {
    order.push("watermark");
    return Promise.resolve(watermarkAt(at));
  },
  rows: async function* rows(table: string) {
    order.push(`rows:${table}`);
    if (table !== "tasks") return;
    for (const row of existing) yield row;
  },
});

describe("backfill", () => {
  test("reads current state at a watermark captured before the read, then streams from it", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    // four transactions the reader's snapshot already covers, so the stream must skip them
    for (let n = 0; n < 4; n += 1) source.commit(() => undefined);
    const order: string[] = [];

    const running = (
      await startCapture({ engine, source, mappings, backfill: reader(4, order) })
    ).unwrap();

    // captured first, or a row written during the read appears in neither the snapshot nor the stream
    expect(order[0]).toBe("watermark");
    expect(engine.rowsIn(TASKS, ACME).size).toBe(2);
    expect(engine.rowsIn(TASKS, GLOBEX).size).toBe(1);
    expect(storedWatermark(engine, "app")).toBe(watermarkAt(4));

    source.commit((tx) =>
      tx.update("tasks", "t1", {
        id: "t1",
        orgId: "acme",
        title: "changed after the read",
        ownerId: "acct_alice",
      }),
    );
    await until(() => source.pending() === 0, "the streamed change");
    running.stop();
    await running.done;

    expect(rowsOf(engine, ACME, TASKS)).toEqual([
      ["t1", { id: "t1", orgId: "acme", title: "changed after the read", ownerId: "acct_alice" }],
      ["t2", { id: "t2", orgId: "acme", title: "also there", ownerId: "acct_alice" }],
    ]);
  });

  test("a restart does not backfill again: the row already says where to resume", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const first = (
      await startCapture({ engine, source, mappings, backfill: reader(1, []) })
    ).unwrap();
    first.stop();
    await first.done;

    const again: string[] = [];
    const second = (
      await startCapture({ engine, source, mappings, backfill: reader(9, again) })
    ).unwrap();
    second.stop();
    await second.done;

    expect(again).toEqual([]);
    expect(engine.rowsIn(TASKS, ACME).size).toBe(2);
    expect(storedWatermark(engine, "app")).toBe(watermarkAt(1));
  });
});
