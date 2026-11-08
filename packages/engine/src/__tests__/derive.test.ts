import type { CellValue, ColumnName, Row } from "@syncmesh/kernel";

import { parseAdapterId, parsePartitionKey } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { from, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { FoldBatch } from "../fold.js";
import type { DerivedRow, StateStore } from "../state-store.js";

import { createMemoryStateStore } from "../state-store.js";
import { StoreFailure } from "../store.js";
import { createValidator } from "../validate.js";
import { N1, NOTES, PEER_A, column, procedure, row, setup } from "./fixtures.js";

/*
 * Derived columns (RFC-0023 §16.4): computed by each replica from its document and written into
 * its own row. The engine carries them beside a write or a cover into the state store's `derive`
 * and names them in the fold batch; they are never a cell, an event's change or a digest's input.
 */

const CONTENT = column("content");
const TITLE = column("title");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([[NOTES, new Map<ColumnName, typeof LORO>([[CONTENT, LORO]])]]);
const W1 = parsePartitionKey("workspace:w1").unwrap();
const EDIT = procedure("notes.edit");

const schema = syncSchema({
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        content: t.blob({ merge: { id: "loro@1" } }).nullable(),
      },
      partition: partition("workspace"),
      derive: { title: from("content", (doc: string) => doc) },
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});
const validate = createValidator({ schema, grantFor: null, docs: DOCS });

/** A memory state store that also takes derived rows, recording each call and its order. */
const recording = (fail = false) => {
  const calls: (readonly DerivedRow[])[] = [];
  const store: StateStore = {
    ...createMemoryStateStore(),
    derive: (rows) => {
      calls.push(rows);
      return Promise.resolve(
        fail
          ? Result.err(new StoreFailure({ message: "the table is gone" }))
          : Result.ok(undefined),
      );
    },
  };
  return { store, calls };
};

const node = (stateStore: StateStore) => {
  const n = setup(PEER_A, 100, { docs: DOCS, validate, stateStore });
  const batches: FoldBatch[] = [];
  n.engine.onFoldBatch((batch) => batches.push(batch));
  return { ...n, batches };
};

const titled = (title: string): readonly DerivedRow[] => [
  { table: NOTES, key: N1, values: new Map<ColumnName, CellValue>([[TITLE, title]]) },
];

const insertNote = async (n: ReturnType<typeof node>) =>
  (
    await n.engine.mutate(EDIT, (tx) => tx.insert(NOTES, N1, row({ id: "n1" })), {
      partition: W1,
    })
  ).unwrap();

const edit = (bytes: number) => ({
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(bytes) },
});

describe("a derived column is never written as a value", () => {
  test("a row write naming one is DocColumnWrite; an insert that leaves it out passes", () => {
    const verdict = (cells: Row, kind: "insert" | "update") => {
      const change =
        kind === "insert"
          ? { kind, table: NOTES, key: N1, row: cells }
          : { kind, table: NOTES, key: N1, patch: cells };
      const r = validate.validate(
        { peerId: PEER_A, partition: W1, changes: [change] },
        { row: () => undefined, partition: () => W1 },
      );
      return r.isOk() ? "ok" : r.error._tag;
    };
    expect(verdict(row({ id: "n1" }), "insert")).toBe("ok");
    expect(verdict(row({ id: "n1", title: "mine" }), "insert")).toBe("DocColumnWrite");
    expect(verdict(row({ title: "mine" }), "update")).toBe("DocColumnWrite");
  });
});

describe("a write carries its derived values into the row, not into the event", () => {
  test("a doc flush with derived values writes them in its transaction and names the row in the batch", async () => {
    const { store, calls } = recording();
    const n = node(store);
    await insertNote(n);
    n.batches.length = 0;
    const event = (
      await n.engine.mutate(EDIT, (tx) => tx.doc(NOTES, N1, edit(1)), {
        partition: W1,
        derived: titled("Q3"),
      })
    ).unwrap();
    expect(calls).toEqual([titled("Q3")]);
    // a doc edit alone moves no key; the derived write is what tells a live query to re-read
    expect(n.batches.map((b) => [b.source, [...(b.writeKeys.get(NOTES) ?? [])]])).toEqual([
      ["local", [N1]],
    ]);
    expect(event.changes.map((c) => c.kind)).toEqual(["doc"]);
    expect(n.engine.state().get(NOTES)?.get(N1)?.cells.has(TITLE)).toBe(false);
  });

  test("the same write without derived values moves no key", async () => {
    const { store, calls } = recording();
    const n = node(store);
    await insertNote(n);
    n.batches.length = 0;
    (await n.engine.mutate(EDIT, (tx) => tx.doc(NOTES, N1, edit(1)), { partition: W1 })).unwrap();
    expect(calls).toEqual([]);
    expect(n.batches.map((b) => b.writeKeys.size)).toEqual([0]);
  });
});

describe("a cover carries the snapshot's derived values", () => {
  const cover = (title?: string) => ({
    adapter: LORO,
    covers: new Map(),
    version: Uint8Array.of(1),
    snapshot: Uint8Array.of(9),
    mode: "materialised" as const,
    at: Temporal.Instant.fromEpochMilliseconds(5),
    covered: [],
    ...(title !== undefined && { derived: new Map<ColumnName, CellValue>([[TITLE, title]]) }),
  });
  const doc = { table: NOTES, key: N1, column: CONTENT };

  test("written with the cover, then announced as a `derive` batch naming the row", async () => {
    const { store, calls } = recording();
    const n = node(store);
    await insertNote(n);
    n.batches.length = 0;
    (await n.engine.coverDoc(doc, cover("Q3"))).unwrap();
    expect(calls).toEqual([titled("Q3")]);
    expect(
      n.batches.map((b) => [b.source, b.eventCount, [...(b.writeKeys.get(NOTES) ?? [])]]),
    ).toEqual([["derive", 0, [N1]]]);
  });

  test("a cover with none writes and announces nothing", async () => {
    const { store, calls } = recording();
    const n = node(store);
    await insertNote(n);
    n.batches.length = 0;
    (await n.engine.coverDoc(doc, cover())).unwrap();
    expect(calls).toEqual([]);
    expect(n.batches).toEqual([]);
  });

  test("a refused cover writes no derived value", async () => {
    const { store, calls } = recording();
    const n = node(store);
    await insertNote(n);
    (await n.engine.coverDoc(doc, cover("first"))).unwrap();
    // built on no head, but one is there now: stale
    const stale = await n.engine.coverDoc(doc, cover("second"));
    expect(stale.isErr() && stale.error._tag).toBe("DocCoverStale");
    expect(calls).toEqual([titled("first")]);
  });
});
