import {
  createEngine,
  createMemoryEventStore,
  type DocAppend,
  type FoldBatch,
} from "@syncmesh/engine";
import {
  createHlcClock,
  parseAdapterId,
  parsePeerId,
  parseSeqNum,
  type ColumnName,
  type Procedure,
  type Row,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { AnyAdapter } from "../adapter.js";
import type { Entry } from "../entry.js";
import type { DocsEngine } from "../materialise.js";

import { createRederive } from "../rederive.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const CONTENT = "content" as ColumnName;
const TITLE = "title" as ColumnName;
const N1 = "n1" as RowKey;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const PEER = parsePeerId("ab".repeat(32)).unwrap();
const LORO = parseAdapterId("loro@1").unwrap();
const ADDRESS = { table: NOTES, key: N1, column: CONTENT };

const titled = (title: string): Row => new Map([[TITLE, title]]);

describe("createRederive", () => {
  test("a recomputation a local write overtook is not taken for the row's last values", async () => {
    const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(1) });
    const engine = createEngine({ peerId: PEER, clock, store: createMemoryEventStore() });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, titled("")))).unwrap();

    const listeners = new Set<(batch: FoldBatch) => void>();
    const emit = (batch: FoldBatch) => {
      for (const listener of listeners) listener(batch);
    };
    const writes: Row[] = [];
    let release = () => {};
    let gate: Promise<void> | undefined;
    const fake = {
      ...engine,
      onFoldBatch: (listener: (batch: FoldBatch) => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      writeDerived: async (row: { readonly values: Row }) => {
        writes.push(row.values);
        await gate;
        return Result.ok(true);
      },
    } satisfies DocsEngine;

    // SAFETY: only `version` is called, to see the open replica below holds nothing unflushed; the
    // rest is looked up, never called: the replica is read, not loaded
    const adapter = { ...({} as AnyAdapter), version: () => new Uint8Array() };
    const replica = {
      adapter,
      lineage: undefined,
      doc: { title: "Recomputed" },
      refs: 1,
      status: "current",
      flushed: new Uint8Array(),
      stash: [],
      seen: new Map(),
      listeners: new Set(),
      stop: () => {},
      timers: {},
    } satisfies Entry;
    const rederive = createRederive({
      engine: fake,
      docs: new Map([[NOTES, new Map([[CONTENT, LORO]])]]),
      adapters: new Map([[LORO, adapter]]),
      derive: Object.assign(
        new Map([
          [
            NOTES,
            new Map([
              [
                CONTENT,
                {
                  columns: [TITLE],
                  compute: <D>(doc: D) =>
                    // SAFETY: the replica below is the only document this deriver is handed
                    Result.ok(titled((doc as { readonly title: string }).title)),
                  check: (values: Row) => Result.ok(values),
                },
              ],
            ]),
          ],
        ]),
        { sealedKinds: new Set<string>() },
      ),
      replica: () => 1n,
      held: () => replica,
    });

    // the recomputation's write is in flight when a flush's local write folds
    gate = new Promise((resolve) => (release = resolve));
    const first = rederive.rederive(ADDRESS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toEqual([titled("Recomputed")]);
    rederive.flushing(ADDRESS, titled("Flushed"), new Set());
    const flushed = {
      entry: {
        ...ADDRESS,
        author: PEER,
        seq: parseSeqNum(2).unwrap(),
        index: 0,
        hlc: clock.tick(),
        size: 1,
        state: "tail",
      },
      adapter: LORO,
      update: { bytes: new Uint8Array([1]) },
    } satisfies DocAppend;
    emit({
      source: "local",
      eventCount: 1,
      writeTables: new Set(),
      writeKeys: new Map(),
      docs: [flushed],
    });
    gate = undefined;
    release();
    await first;

    // the flush's values are the row's, so the next recomputation that finds the replica's writes them
    emit({
      source: "remote",
      eventCount: 1,
      writeTables: new Set(),
      writeKeys: new Map(),
      docs: [{ ...flushed, entry: { ...flushed.entry, seq: parseSeqNum(3).unwrap() } }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    rederive.stop();
    expect(writes).toEqual([titled("Recomputed"), titled("Recomputed")]);
  });
});
