import { hlcOf, parseAdapterId, type ColumnName } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { DocWrite } from "../tx.js";

import { tableDigests } from "../digest.js";
import { createMemoryDocStore, docDigests, type DocStore } from "../doc-log.js";
import { createLink } from "../link.js";
import { createMemoryStateStore } from "../state-store.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, column, key, row, seq, setup } from "./fixtures.js";

const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([[NOTES, new Map<ColumnName, typeof LORO>([[CONTENT, LORO]])]]);
/** Well after every fixture stamp (they sit at ~100 ms). */
const T0 = Temporal.Instant.fromEpochMilliseconds(10 * 60 * 60 * 1000);

const edit: DocWrite = { column: CONTENT, adapter: LORO, update: { bytes: Uint8Array.of(7) } };

/**
 * A doc store in which the entries for `covered` are already `covered` — what a materialiser
 * leaves behind once a persisted snapshot holds them (RFC-0023 §6.3), which P2 has no way to do yet.
 * The fold's own append of the same ids is a no-op, so they stay covered.
 */
const coveredStore = (covered: readonly number[]): DocStore => {
  const store = createMemoryDocStore();
  void store.append(
    covered.map((n) => ({
      table: NOTES,
      key: N1,
      column: CONTENT,
      author: PEER_A,
      seq: seq(n),
      index: 0,
      hlc: hlcOf(0, 0),
      size: 1,
      state: "covered" as const,
    })),
  );
  return store;
};

/** A writes: insert, doc edit, insert, doc edit, insert — seq 1 to 5 — and B acknowledges all five. */
const history = async (docStore: DocStore, undoDepth = 0) => {
  const a = setup(PEER_A, 100, {
    stateStore: createMemoryStateStore(),
    docs: DOCS,
    docStore,
    undoDepth,
  });
  const b = setup(PEER_B, 100, { stateStore: createMemoryStateStore(), docs: DOCS });
  const link = createLink(a.engine, b.engine, { now: () => T0 });
  const insert = (k: string) =>
    a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(k), row({ id: k })));
  const change = () => a.engine.mutate(CREATE, (tx) => tx.doc(NOTES, N1, edit));
  (await insert("n1")).unwrap();
  (await change()).unwrap();
  (await insert("n2")).unwrap();
  (await change()).unwrap();
  (await insert("n3")).unwrap();
  (await link.catchUp()).unwrap();
  return { a, b };
};

const observable = async (engine: ReturnType<typeof setup>["engine"]) => ({
  rows: tableDigests(engine.state()),
  docs: docDigests((await engine.docLog()).unwrap()),
  log: (await engine.docLog()).unwrap(),
  heads: (await engine.docHeads()).unwrap(),
  cursors: (await engine.cursors()).unwrap(),
});

describe("compaction with documents — RFC-0023 §8.3", () => {
  test("an event whose doc change no persisted snapshot covers is never compacted", async () => {
    const { a } = await history(createMemoryDocStore());
    const done = (await a.engine.compact({ now: T0 })).unwrap();
    // seq 2 holds an uncovered doc change: the floor stops below it, whatever the acks say
    expect(done.floor.synced.get(PEER_A)).toBe(seq(1));
    expect(done.removed).toBe(1);
    const held = (await a.store.all()).unwrap().map((e) => e.event.seqNum);
    expect(held).toEqual([2, 3, 4, 5].map(seq));
  });

  test("once covered, the doc changes compact like any event", async () => {
    const { a } = await history(coveredStore([2, 4]));
    const done = (await a.engine.compact({ now: T0 })).unwrap();
    expect(done.floor.synced.get(PEER_A)).toBe(seq(5));
    expect((await a.store.all()).unwrap()).toHaveLength(0);
  });

  test("the last undoDepth writes hold their doc changes, covered or not (clause 3)", async () => {
    const held = await history(coveredStore([2, 4]), 2);
    // the ring holds seq 4 and 5; seq 4 carries a doc change, so the floor stops at 3
    const done = (await held.a.engine.compact({ now: T0 })).unwrap();
    expect(done.floor.synced.get(PEER_A)).toBe(seq(3));
    const free = await history(coveredStore([2, 4]), 1);
    const all = (await free.a.engine.compact({ now: T0 })).unwrap();
    expect(all.floor.synced.get(PEER_A)).toBe(seq(5));
  });

  test("unobservable: rows, doc log, heads, digests and cursors are identical after compact()", async () => {
    for (const store of [createMemoryDocStore(), coveredStore([2, 4])]) {
      const { a, b } = await history(store);
      const before = await observable(a.engine);
      (await a.engine.compact({ now: T0 })).unwrap();
      expect(await observable(a.engine)).toEqual(before);
      // and the peer that acknowledged everything holds the same documents
      const theirs = await observable(b.engine);
      expect(theirs.rows).toEqual(before.rows);
      expect(theirs.docs).toEqual(before.docs);
    }
  });
});
