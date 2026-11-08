import {
  counterValue,
  getRecord,
  docLineage,
  parseAdapterId,
  parsePartitionKey,
  readRow,
  type CellRule,
  type ColumnName,
  type MergeSpec,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import type { EngineOptions } from "../options.js";

import { createEngine } from "../engine.js";
import { UnknownTable } from "../errors.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator, type Validator } from "../validate.js";
import { CREATE, column, fakeClock, key, N1, NOTES, PEER_A, PEER_B, row } from "./fixtures.js";

const N2 = key("n2");

const withUndo = (undoDepth = 3, extra: Partial<EngineOptions> = {}) => {
  const store = createMemoryEventStore();
  const engine = createEngine({
    peerId: PEER_A,
    clock: fakeClock(100),
    store,
    undoDepth,
    ...extra,
  });
  return { engine, store };
};

describe("revert", () => {
  test("reverting an update restores the columns it touched — and nothing else", async () => {
    const { engine } = withUndo();
    await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t", body: "b" })));
    const e = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "changed" })))
    ).unwrap();
    await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "kept" })));
    const r = (await engine.revert(e.id)).unwrap();
    expect(String(r.event?.procedure)).toBe("revert");
    expect(r.skipped).toEqual([]);
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "t", body: "kept" }));
  });

  test("reverting an insert deletes the row; reverting a delete restores it", async () => {
    const { engine } = withUndo();
    const ins = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))
    ).unwrap();
    (await engine.revert(ins.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toBeUndefined();

    await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N2, row({ title: "x", body: "y" })));
    const del = (await engine.mutate(CREATE, (tx) => tx.delete(NOTES, N2))).unwrap();
    expect(readRow(engine.state(), NOTES, N2)).toBeUndefined();
    (await engine.revert(del.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N2)).toEqual(row({ title: "x", body: "y" }));
  });

  test("a write of document updates alone is refused, and stays revertable", async () => {
    const { engine } = withUndo();
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))).unwrap();
    const doc = { column: column("content"), adapter: parseAdapterId("loro@1").unwrap() };
    const e = (
      await engine.mutate(CREATE, (tx) =>
        tx.doc(NOTES, N1, { ...doc, update: { bytes: Uint8Array.of(1) } }),
      )
    ).unwrap();
    const refused = await engine.revert(e.id);
    expect(refused.isErr() && refused.error.message).toContain("adapter");
    // the ring kept the write: asked again, it is the same refusal, not "not among the last"
    const again = await engine.revert(e.id);
    expect(again.isErr() && again.error.message).toContain("adapter");
  });

  test("a column that did not exist before is reverted to null", async () => {
    const { engine } = withUndo();
    await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })));
    const e = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ extra: 1 })))
    ).unwrap();
    (await engine.revert(e.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "t", extra: null }));
  });

  test("the compensating event is written in the original event's partition", async () => {
    const { engine } = withUndo();
    // SAFETY: test fixture; partition keys are `kind:id` text and the schema owns the rules
    const partition = "org:acme" as never;
    const e = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })), { partition })
    ).unwrap();
    const r = (await engine.revert(e.id)).unwrap();
    expect(r.event?.partition).toBe(partition);
  });

  test("only the last undoDepth writes are revertable; a revert is itself revertable (redo)", async () => {
    const { engine } = withUndo(2);
    const first = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ n: 1 })))
    ).unwrap();
    const second = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ n: 2 })))
    ).unwrap();
    const third = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ n: 3 })))
    ).unwrap();
    expect(engine.canRevert(first.id)).toBe(false);
    expect(engine.canRevert(third.id)).toBe(true);
    const r = await engine.revert(first.id);
    expect(r.isErr() && r.error._tag).toBe("CannotRevert");

    const undone = (await engine.revert(third.id)).unwrap().event;
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ n: 2 }));
    expect(undone).toBeDefined();
    if (undone !== undefined) (await engine.revert(undone.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ n: 3 }));
    expect(engine.canRevert(third.id)).toBe(false);
    expect(engine.canRevert(second.id)).toBe(true);
  });

  test("undoDepth 0 (the default): nothing is revertable", async () => {
    const store = createMemoryEventStore();
    const engine = createEngine({ peerId: PEER_A, clock: fakeClock(100), store });
    const e = (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ n: 1 })))).unwrap();
    expect(engine.canRevert(e.id)).toBe(false);
    expect((await engine.revert(e.id)).isErr()).toBe(true);
  });
});

/** Two engines of one mesh: A reverts, B's later clock writes in between. */
const pair = () => {
  const a = createEngine({
    peerId: PEER_A,
    clock: fakeClock(100),
    store: createMemoryEventStore(),
    undoDepth: 5,
  });
  const b = createEngine({
    peerId: PEER_B,
    clock: fakeClock(500),
    store: createMemoryEventStore(),
  });
  const deliver = async (event: Awaited<ReturnType<typeof a.mutate>>) =>
    (await b.receive({ event: event.unwrap() })).unwrap();
  const back = async (event: Awaited<ReturnType<typeof b.mutate>>) =>
    (await a.receive({ event: event.unwrap() })).unwrap();
  return { a, b, deliver, back };
};

describe("revert compensates only the cells that still hold the write (RFC-0023 §16.3)", () => {
  test("a colleague's concurrent edit survives the undo, and is reported superseded", async () => {
    const { a, b, deliver, back } = pair();
    await deliver(
      await a.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t", body: "b" }))),
    );
    const mine = (
      await a.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "mine", body: "mine" })))
    ).unwrap();
    (await b.receive({ event: mine })).unwrap();
    await back(await b.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "theirs" }))));

    const r = (await a.revert(mine.id)).unwrap();
    expect(readRow(a.state(), NOTES, N1)).toEqual(row({ title: "t", body: "theirs" }));
    expect(r.skipped).toEqual([
      { table: NOTES, key: N1, column: column("body"), reason: "superseded" },
    ]);
    // the compensation carries only the cell it restores, so B converges on the same row
    expect(r.event?.changes).toEqual([
      { kind: "update", table: NOTES, key: N1, patch: row({ title: "t" }) },
    ]);
    if (r.event !== undefined) (await b.receive({ event: r.event })).unwrap();
    expect(readRow(b.state(), NOTES, N1)).toEqual(readRow(a.state(), NOTES, N1));
  });

  test("when every cell was changed since, nothing is written and all of it is reported", async () => {
    const { a, b, deliver, back } = pair();
    await deliver(await a.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" }))));
    const mine = (
      await a.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "mine" })))
    ).unwrap();
    (await b.receive({ event: mine })).unwrap();
    await back(await b.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "theirs" }))));
    const r = (await a.revert(mine.id)).unwrap();
    expect(r.event).toBeUndefined();
    expect(r.skipped).toEqual([
      { table: NOTES, key: N1, column: column("title"), reason: "superseded" },
    ]);
    expect(readRow(a.state(), NOTES, N1)).toEqual(row({ title: "theirs" }));
    expect(a.canRevert(mine.id)).toBe(false);
  });

  test("an update is not undone into a row someone deleted since: the delete stands", async () => {
    const { a, b, deliver, back } = pair();
    await deliver(await a.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" }))));
    const mine = (
      await a.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "mine" })))
    ).unwrap();
    (await b.receive({ event: mine })).unwrap();
    await back(await b.mutate(CREATE, (tx) => tx.delete(NOTES, N1)));
    const r = (await a.revert(mine.id)).unwrap();
    expect(r.event).toBeUndefined();
    expect(r.skipped).toEqual([{ table: NOTES, key: N1, reason: "superseded" }]);
    expect(readRow(a.state(), NOTES, N1)).toBeUndefined();
  });

  test("a delete is not undone over a row someone wrote again since", async () => {
    const { a, b, deliver, back } = pair();
    await deliver(await a.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" }))));
    const mine = (await a.mutate(CREATE, (tx) => tx.delete(NOTES, N1))).unwrap();
    (await b.receive({ event: mine })).unwrap();
    await back(await b.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "again" }))));
    const r = (await a.revert(mine.id)).unwrap();
    expect(r.event).toBeUndefined();
    expect(r.skipped).toEqual([{ table: NOTES, key: N1, reason: "superseded" }]);
    expect(readRow(a.state(), NOTES, N1)).toEqual(row({ title: "again" }));
  });

  test("a document update in a mixed write is reported, never compensated here", async () => {
    const { engine } = withUndo();
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))).unwrap();
    const content = column("content");
    const e = (
      await engine.mutate(CREATE, (tx) => {
        tx.update(NOTES, N1, row({ title: "changed" }));
        tx.doc(NOTES, N1, {
          column: content,
          adapter: parseAdapterId("loro@1").unwrap(),
          update: { bytes: Uint8Array.of(1) },
        });
      })
    ).unwrap();
    const r = (await engine.revert(e.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "t" }));
    expect(r.skipped).toEqual([{ table: NOTES, key: N1, column: content, reason: "document" }]);
  });
});

describe("revert by the column's merge rule, and of what is already gone", () => {
  const VIEWS = column("views");
  const SCORE = column("score");
  const RULES: MergeSpec = new Map([
    [
      NOTES,
      new Map<ColumnName, CellRule>([
        [VIEWS, "counter"],
        [SCORE, "max"],
      ]),
    ],
  ]);

  test("a counter increment is undone by the increment that cancels it", async () => {
    const { engine } = withUndo(3, { merge: RULES });
    (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ views: { "+": 2 } })))
    ).unwrap();
    const e = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ views: { "+": 5 } })))
    ).unwrap();
    const views = () => counterValue(readRow(engine.state(), NOTES, N1)?.get(VIEWS) ?? null);
    expect(views()).toBe(7);
    const r = (await engine.revert(e.id)).unwrap();
    expect(views()).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(r.event?.changes).toEqual([
      { kind: "update", table: NOTES, key: N1, patch: row({ views: { "+": -5 } }) },
    ]);
  });

  test("a max cell the write raised cannot come back down, and says so", async () => {
    const { engine } = withUndo(3, { merge: RULES });
    (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t", score: 3 })))
    ).unwrap();
    const e = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "x", score: 9 })))
    ).unwrap();
    const r = (await engine.revert(e.id)).unwrap();
    expect(r.skipped).toEqual([{ table: NOTES, key: N1, column: SCORE, reason: "merge" }]);
    expect(r.event?.changes).toEqual([
      { kind: "update", table: NOTES, key: N1, patch: row({ title: "t" }) },
    ]);
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "t", score: 9 }));
  });

  test("an insert whose row is gone already writes nothing, and reports the row superseded", async () => {
    const { engine } = withUndo();
    const ins = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))
    ).unwrap();
    (await engine.mutate(CREATE, (tx) => tx.delete(NOTES, N1))).unwrap();
    const r = (await engine.revert(ins.id)).unwrap();
    expect(r.event).toBeUndefined();
    expect(r.skipped).toEqual([{ table: NOTES, key: N1, reason: "superseded" }]);
  });

  test("an insert a colleague edited since is deleted, and their cells are reported overridden", async () => {
    const { a, b, deliver, back } = pair();
    const ins = (
      await a.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))
    ).unwrap();
    await deliver(Result.ok(ins));
    await back(await b.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "theirs" }))));
    const r = (await a.revert(ins.id)).unwrap();
    expect(readRow(a.state(), NOTES, N1)).toBeUndefined();
    expect(r.skipped).toEqual([
      { table: NOTES, key: N1, column: column("body"), reason: "overridden" },
    ]);
  });

  test("a compensation the engine refuses leaves the write revertable", async () => {
    let refusing = false;
    const validate: Validator = {
      validate: () =>
        refusing
          ? Result.err(new UnknownTable({ table: "notes", message: "refused for the test" }))
          : Result.ok(undefined),
    };
    const { engine } = withUndo(3, { validate });
    (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t" })))).unwrap();
    const e = (
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "x" })))
    ).unwrap();
    refusing = true;
    expect((await engine.revert(e.id)).isErr()).toBe(true);
    expect(engine.canRevert(e.id)).toBe(true);
    refusing = false;
    (await engine.revert(e.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ title: "t" }));
  });
});

describe("revert of a row that holds a document", () => {
  const CONTENT = column("content");
  const LORO = parseAdapterId("loro@1").unwrap();
  const DOCS = new Map([[NOTES, new Map([[CONTENT, LORO]])]]);
  const W1 = parsePartitionKey("workspace:w1").unwrap();
  const schema = syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), title: t.text(), content: t.blob().nullable() },
        partition: partition("workspace"),
        allow: ({ allow }) => ({ $default: allow }),
      },
    },
  });

  test("a delete of a replaced document's row comes back with its lineage, never a value write", async () => {
    const validate = createValidator({ schema, grantFor: null, docs: DOCS });
    const { engine } = withUndo(5, { docs: DOCS, validate, docAdapters: new Set([LORO]) });
    const write = async (fn: Parameters<typeof engine.mutate>[1]) =>
      (await engine.mutate(CREATE, fn, { partition: W1 })).unwrap();
    await write((tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write((tx) =>
      tx.doc(NOTES, N1, {
        column: CONTENT,
        adapter: LORO,
        update: { bytes: Uint8Array.of(1) },
        genesis: true,
      }),
    );
    const lineage = docLineage(getRecord(engine.state(), NOTES, N1), CONTENT);
    const del = await write((tx) => tx.delete(NOTES, N1));
    const r = (await engine.revert(del.id)).unwrap();
    expect(r.event?.changes).toEqual([
      { kind: "insert", table: NOTES, key: N1, row: row({ id: "n1", title: "t" }) },
    ]);
    expect(docLineage(getRecord(engine.state(), NOTES, N1), CONTENT)).toBe(lineage);
    expect(engine.canRevert(del.id)).toBe(false);
  });
});
