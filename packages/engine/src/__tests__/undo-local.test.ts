import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { CREATE, fakeClock, key, N1, NOTES, PEER_A, row } from "./fixtures.js";

const N2 = key("n2");

const withUndo = (undoDepth = 3) => {
  const store = createMemoryEventStore();
  const engine = createEngine({ peerId: PEER_A, clock: fakeClock(100), store, undoDepth });
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
    expect(String(r.procedure)).toBe("revert");
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
    expect(r.partition).toBe(partition);
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

    const undone = (await engine.revert(third.id)).unwrap();
    expect(readRow(engine.state(), NOTES, N1)).toEqual(row({ n: 2 }));
    (await engine.revert(undone.id)).unwrap();
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
