import { parsePartitionKey, readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { partitionsIn } from "../snapshot.js";
import {
  CREATE,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  column,
  key,
  procedure,
  row,
  setup,
} from "./fixtures.js";

const TITLE = column("title");

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();
const DELETE = procedure("notes.delete");

type Side = ReturnType<typeof setup>;

const write = (s: Side, id: string, title: string, partition = ACME) =>
  s.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ title })), { partition });
const remove = (s: Side, id: string, partition = ACME) =>
  s.engine.mutate(DELETE, (tx) => tx.delete(NOTES, key(id)), { partition });

describe("snapshot", () => {
  test("carries the rows and the coverage they stand for", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "one")).unwrap();
    (await write(a, "n2", "two")).unwrap();

    const snap = a.engine.snapshot();
    expect(snap.rows.map((r) => String(r.key)).sort()).toEqual(["n1", "n2"]);
    expect(Number(snap.coverage.synced.get(PEER_A))).toBe(2);
    expect(snap.scope).toBeUndefined(); // no interest: complete for everything this peer holds
    expect(partitionsIn(snap).map(String)).toEqual(["org:acme"]);
  });

  test("tombstones travel, or a joiner resurrects every row anyone deleted", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "one")).unwrap();
    (await remove(a, "n1")).unwrap();
    const snap = a.engine.snapshot();
    expect(snap.rows).toHaveLength(1); // the row is gone, the fact of its going is not

    const b = setup(PEER_B, 200);
    await b.engine.installSnapshot(snap);
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
  });

  test("an interest narrows it, and the snapshot says which slice it is complete for", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "acme")).unwrap();
    (await write(a, "g1", "globex", GLOBEX)).unwrap();

    const scoped = a.engine.snapshot({ interest: { partitions: [ACME] } });
    expect(scoped.rows.map((r) => String(r.key))).toEqual(["n1"]);
    expect(scoped.scope?.partitions?.map(String)).toEqual(["org:acme"]);
    expect(a.engine.snapshot().rows).toHaveLength(2);
  });
});

describe("installSnapshot", () => {
  test("state instead of history: the joiner holds the rows and stops asking for the events", async () => {
    const a = setup(PEER_A, 100);
    for (let i = 1; i <= 20; i += 1) (await write(a, `n${i}`, `title ${i}`)).unwrap();

    const b = setup(PEER_B, 200);
    const installed = await b.engine.installSnapshot(a.engine.snapshot());
    expect(installed.rows).toBe(20);
    expect(readRow(b.engine.state(), NOTES, key("n7"))?.get(TITLE)).toBe("title 7");

    // the coverage came with the rows, so b will not ask a for those twenty events again
    expect(Number(b.engine.coverage().synced.get(PEER_A))).toBe(20);
    expect((await a.engine.eventsSince(b.engine.coverage().synced)).unwrap()).toEqual([]);
    // and its own log is still empty: it holds state it never replayed
    expect((await b.engine.eventsSince(new Map())).unwrap()).toEqual([]);
  });

  test("one fold batch however many rows, so a joining device renders once", async () => {
    const a = setup(PEER_A, 100);
    for (let i = 1; i <= 50; i += 1) (await write(a, `n${i}`, `t${i}`)).unwrap();
    const b = setup(PEER_B, 200);
    const batches: { source: string; rows: number }[] = [];
    b.engine.onFoldBatch(
      (batch) =>
        void batches.push({
          source: batch.source,
          rows: [...batch.writeKeys.values()].reduce((n, set) => n + set.size, 0),
        }),
    );
    await b.engine.installSnapshot(a.engine.snapshot());
    expect(batches).toEqual([{ source: "snapshot", rows: 50 }]);
  });

  test("a backfill never resurrects a tombstone, whichever order it arrives in", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "old")).unwrap();
    const stale = a.engine.snapshot(); // taken while the row was alive

    const b = setup(PEER_B, 200);
    await b.engine.installSnapshot(stale);
    expect(readRow(b.engine.state(), NOTES, N1)?.get(TITLE)).toBe("old");

    // b learns of the delete, then the stale snapshot arrives again from a slower source
    (await remove(a, "n1")).unwrap();
    (await b.engine.receiveBatch((await a.engine.eventsSince(new Map())).unwrap())).unwrap();
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
    await b.engine.installSnapshot(stale);
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined(); // the delete is newer, and wins
  });

  test("installing twice is installing once, and an older snapshot never lowers coverage", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "one")).unwrap();
    const early = a.engine.snapshot();
    (await write(a, "n2", "two")).unwrap();
    const later = a.engine.snapshot();

    const b = setup(PEER_B, 200);
    await b.engine.installSnapshot(later);
    expect(Number(b.engine.coverage().synced.get(PEER_A))).toBe(2);
    await b.engine.installSnapshot(early); // arrives late, says less
    expect(Number(b.engine.coverage().synced.get(PEER_A))).toBe(2); // and takes nothing away
    expect(b.engine.state().get(NOTES)?.size).toBe(2);
  });

  test("a snapshot and live events interleave: the result is what a full replay would give", async () => {
    const a = setup(PEER_A, 100);
    (await write(a, "n1", "one")).unwrap();
    const snap = a.engine.snapshot();
    (await write(a, "n1", "one revised")).unwrap();
    (await write(a, "n2", "two")).unwrap();

    // b installs the snapshot and folds the newer events; a third peer replays everything
    const b = setup(PEER_B, 200);
    await b.engine.installSnapshot(snap);
    (await b.engine.receiveBatch((await a.engine.eventsSince(new Map())).unwrap())).unwrap();

    const replayed = setup(PEER_B, 300);
    (await replayed.engine.receiveBatch((await a.engine.eventsSince(new Map())).unwrap())).unwrap();
    expect(b.engine.digest().get(NOTES)).toBe(replayed.engine.digest().get(NOTES));
  });

  test("an empty snapshot is not a fold, and still adopts what it stood for", async () => {
    const a = setup(PEER_A, 100);
    const b = setup(PEER_B, 200);
    let notified = 0;
    b.engine.onFoldBatch(() => void (notified += 1));
    const installed = await b.engine.installSnapshot(a.engine.snapshot());
    expect(installed.rows).toBe(0);
    expect(notified).toBe(0);
  });
});
