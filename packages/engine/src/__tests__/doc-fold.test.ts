import {
  compareHlc,
  getRecord,
  docLineage,
  isJsonArray,
  LINEAGE_RULE,
  parseAdapterId,
  parsePartitionKey,
  readLineageCell,
  type CellValue,
  type ColumnName,
  type LineageId,
  type PeerId,
  type RowKey,
  type RowRecord,
  type SyncEvent,
} from "@syncmesh/kernel";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { deriveLineage } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { EngineError } from "../errors.js";
import type { DocWrite } from "../tx.js";

import { openEngine } from "../boot.js";
import { tableDigests } from "../digest.js";
import { docDigests } from "../doc-log.js";
import { createMemoryStateStore } from "../state-store.js";
import { createValidator } from "../validate.js";
import {
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  PEER_C,
  column,
  fakeClock,
  procedure,
  row,
  seq,
  setup,
  table,
} from "./fixtures.js";

const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([[NOTES, new Map<ColumnName, typeof LORO>([[CONTENT, LORO]])]]);
const PLAIN = table("plain");
const W1 = parsePartitionKey("workspace:w1").unwrap();
const EDIT = procedure("notes.edit");

const workspace = partition("workspace");
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), content: t.blob().nullable() },
      partition: workspace,
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});
const validate = createValidator({ schema, grantFor: null, docs: DOCS });

/** An engine of the mesh: the doc columns declared, the adapter held or not. */
const node = (peer: PeerId, ms: number, adapter: boolean) =>
  setup(peer, ms, {
    docs: DOCS,
    validate,
    ...(adapter && { docAdapters: new Set([LORO]) }),
  });

const edit = (bytes: number, lineage?: LineageId): DocWrite => ({
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(bytes) },
  ...(lineage !== undefined && { lineage }),
});
const replace = (bytes: number): DocWrite => ({ ...edit(bytes), genesis: true });

type Node = ReturnType<typeof node>;
const write = async (n: Node, fn: Parameters<Node["engine"]["mutate"]>[1]) =>
  (await n.engine.mutate(EDIT, fn, { partition: W1 })).unwrap();
const lineageAt = (n: Node) => docLineage(getRecord(n.engine.state(), NOTES, N1), CONTENT);
const log = async (n: Node) => (await n.engine.docLog()).unwrap();

describe("folding a doc change", () => {
  test("a legacy genesis (key 5 `true`) from a peer is quarantined, and folds nothing", async () => {
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const event = await write(a, (tx) => {
      tx.insert(NOTES, N1, row({ id: "n1", title: "t" }));
      tx.doc(NOTES, N1, replace(1));
    });
    const legacy = {
      ...event,
      changes: event.changes.map((c) => (c.kind === "doc" ? { ...c, legacy: true as const } : c)),
    };
    (await b.engine.receive({ event: legacy })).unwrap();
    expect(b.engine.quarantine().map((p) => p.entry.event.id)).toEqual([event.id]);
    expect(getRecord(b.engine.state(), NOTES, N1)).toBeUndefined();
  });

  test("a local replace derives its lineage, sets the lineage cell and appends a tail entry", async () => {
    const a = node(PEER_A, 100, true);
    const event = await write(a, (tx) => {
      tx.insert(NOTES, N1, row({ id: "n1", title: "t" }));
      tx.doc(NOTES, N1, replace(1));
    });
    const derived = deriveLineage(PEER_A, seq(1), 1);
    const [, genesis] = event.changes;
    expect(genesis?.kind === "doc" && genesis.lineage).toBe(derived);
    expect(lineageAt(a)).toBe(derived);
    expect((await log(a)).map((e) => [e.index, e.lineage, e.state])).toEqual([
      [1, derived, "tail"],
    ]);
    const [head] = (await a.engine.docHeads()).unwrap();
    expect(head).toMatchObject({ lineage: derived, tailCount: 1, tailBytes: 1, mode: "none" });
  });

  test("an edit naming a lineage that does not win is kept as orphaned, never applied", async () => {
    const a = node(PEER_A, 100, true);
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    await write(a, (tx) => tx.doc(NOTES, N1, edit(2))); // names the root, which just lost
    expect((await log(a)).map((e) => e.state)).toEqual(["tail", "orphaned"]);
    const [head] = (await a.engine.docHeads()).unwrap();
    expect(head?.tailCount).toBe(1);
  });

  test("a document edit moves no writeKeys; a genesis moves its row; both report their entries", async () => {
    const a = node(PEER_A, 100, false);
    const batches: { keys: number; docs: number }[] = [];
    a.engine.onFoldBatch((b) =>
      batches.push({ keys: b.writeKeys.get(NOTES)?.size ?? 0, docs: b.docs?.length ?? 0 }),
    );
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write(a, (tx) => tx.doc(NOTES, N1, edit(1)));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(2)));
    expect(batches).toEqual([
      { keys: 1, docs: 0 },
      { keys: 0, docs: 1 },
      { keys: 1, docs: 1 },
    ]);
  });

  test("the first of two concurrent replaces wins, whatever order the geneses land in (§16.1)", async () => {
    // A and B each replace the document while apart; A's is first, and each edits on its own
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const created = await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    (await b.engine.receive({ event: created })).unwrap();
    const aReplace = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    const bReplace = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const bEdit = await write(b, (tx) => tx.doc(NOTES, N1, edit(3, lineageAt(b))));
    const aEdit = await write(a, (tx) => tx.doc(NOTES, N1, edit(4, lineageAt(a))));

    const r = node(PEER_C, 50, true);
    // B's edit arrives before B's genesis, and B's genesis last: the late replace discards nothing
    for (const event of [created, bEdit, aReplace, aEdit, bReplace]) {
      (await r.engine.receive({ event })).unwrap();
    }
    const winner = deriveLineage(PEER_A, seq(2), 0);
    expect(lineageAt(r)).toBe(winner);
    const states = new Map((await log(r)).map((e) => [`${e.author[0]}${e.seq}`, e.state]));
    expect(Object.fromEntries(states)).toEqual({
      a2: "tail",
      a3: "tail",
      b1: "orphaned",
      b2: "orphaned",
    });
    expect(bReplace.seqNum).toBe(seq(1));
  });

  test("a replace names the lineage it replaces, so a restore on top of the winner wins", async () => {
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const created = await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    const imported = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    for (const event of [created, imported]) (await b.engine.receive({ event })).unwrap();
    const first = deriveLineage(PEER_A, seq(2), 0);
    const [genesis] = imported.changes;
    expect(genesis?.kind === "doc" && genesis.parent).toBeUndefined();

    // B restores on top of A's import: later, but a child of the winner, so it wins
    const restored = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const [child] = restored.changes;
    expect(child?.kind === "doc" && child.parent).toBe(first);
    (await a.engine.receive({ event: restored })).unwrap();
    const second = deriveLineage(PEER_B, seq(1), 0);
    expect(lineageAt(a)).toBe(second);
    expect(lineageAt(b)).toBe(second);
  });

  test("a parent that lands late moves the winner, and every label with it, in any order", async () => {
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const created = await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    const g1 = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    for (const event of [created, g1]) (await b.engine.receive({ event })).unwrap();
    const g2 = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const e2 = await write(b, (tx) => tx.doc(NOTES, N1, edit(3, lineageAt(b))));
    const winner = deriveLineage(PEER_B, seq(1), 0);
    const expected = ["a2 orphaned", "b1 tail", "b2 tail"];
    const labels = async (n: Node) =>
      (await log(n))
        .map((e) => `${e.author === PEER_A ? "a" : "b"}${String(e.seq)} ${e.state}`)
        .sort();
    // every interleaving of A's two events and B's two, each author's own kept in order: B's
    // replace names A's lineage as its parent, so until A's genesis lands it hangs off nothing
    const interleavings = (xs: readonly SyncEvent[], ys: readonly SyncEvent[]): SyncEvent[][] => {
      const [x, ...xr] = xs;
      const [y, ...yr] = ys;
      if (x === undefined) return [[...ys]];
      if (y === undefined) return [[...xs]];
      return [
        ...interleavings(xr, ys).map((rest) => [x, ...rest]),
        ...interleavings(xs, yr).map((rest) => [y, ...rest]),
      ];
    };
    const orders = interleavings([created, g1], [g2, e2]);
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      const r = node(PEER_C, 50, true);
      for (const event of order) (await r.engine.receive({ event })).unwrap();
      expect(lineageAt(r)).toBe(winner);
      expect(await labels(r)).toEqual(expected);
    }
    // and in one batch, in either order of authors
    for (const order of [
      [created, g1, g2, e2],
      [g2, e2, created, g1],
    ]) {
      const r = node(PEER_C, 50, true);
      (await r.engine.receiveBatch(order.map((event) => ({ event })))).unwrap();
      expect(lineageAt(r)).toBe(winner);
      expect(await labels(r)).toEqual(expected);
    }
  });
});

describe("the fold is adapter-independent (RFC-0023 §6.4, §13)", () => {
  /** A history from two authors: an insert, root edits, concurrent replaces, and edits on each. */
  const history = async (): Promise<readonly SyncEvent[]> => {
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 150, true);
    const events: SyncEvent[] = [];
    const created = await write(a, (tx) => {
      tx.insert(NOTES, N1, row({ id: "n1", title: "t" }));
      tx.doc(NOTES, N1, edit(1));
    });
    events.push(created);
    (await b.engine.receive({ event: created })).unwrap();
    events.push(await write(a, (tx) => tx.doc(NOTES, N1, edit(2))));
    events.push(await write(b, (tx) => tx.doc(NOTES, N1, edit(3))));
    events.push(await write(a, (tx) => tx.doc(NOTES, N1, replace(4))));
    events.push(await write(b, (tx) => tx.doc(NOTES, N1, replace(5))));
    events.push(await write(a, (tx) => tx.doc(NOTES, N1, edit(6, lineageAt(a)))));
    events.push(await write(b, (tx) => tx.doc(NOTES, N1, edit(7, lineageAt(b)))));
    events.push(
      await write(b, (tx) =>
        tx.doc(NOTES, N1, {
          ...edit(8),
          update: { blob: { hash: "ab".repeat(32), size: 70_000 } },
        }),
      ),
    );
    // one event every peer must park alike: an adapter the schema did not declare
    const stray = await write(b, (tx) => tx.update(NOTES, N1, row({ title: "u" })));
    events.push({
      ...stray,
      changes: [
        ...stray.changes,
        {
          kind: "doc",
          table: NOTES,
          key: N1,
          ...edit(9),
          adapter: parseAdapterId("automerge@3").unwrap(),
        },
      ],
    });
    return events;
  };

  const fingerprint = async (n: Node) => ({
    rows: tableDigests(n.engine.state()),
    docs: docDigests(await log(n)),
    parked: n.engine
      .quarantine()
      .map((p) => `${p.entry.event.id}:${p.verdict._tag}`)
      .sort(),
    lineage: lineageAt(n),
    entries: (await log(n)).map((e) => `${e.author}:${e.seq}:${e.index}:${e.lineage ?? "root"}`),
  });

  test("one engine with the adapter, one without: equal row digests, doc digests and parked sets in every delivery order", async () => {
    const events = await history();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(), { minLength: events.length, maxLength: events.length }),
        fc.nat({ max: 3 }),
        async (keys, batching) => {
          const order = events
            .map((event, i) => [keys[i] ?? 0, event] as const)
            .sort(([x], [y]) => x - y)
            .map(([, event]) => event);
          const holding = node(PEER_C, 10, true);
          const missing = node(PEER_C, 10, false);
          for (const [n, size] of [
            [holding, 1],
            [missing, batching + 1],
          ] as const) {
            for (let i = 0; i < order.length; i += size)
              (
                await n.engine.receiveBatch(order.slice(i, i + size).map((event) => ({ event })))
              ).unwrap();
          }
          const [h, m] = [await fingerprint(holding), await fingerprint(missing)];
          expect(m).toEqual(h);
          expect(h.parked).toHaveLength(1);
          // the labels are the only difference, and they say which build this is
          const labels = async (n: Node) => new Set((await log(n)).map((e) => e.state));
          expect(
            [...(await labels(missing))].every((s) => s === "adapter-missing" || s === "orphaned"),
          ).toBe(true);
          expect((await labels(holding)).has("adapter-missing")).toBe(false);
        },
      ),
      { numRuns: 40, seed: 29 },
    );
  });

  test("the row digest holds the lineage and nothing of a document's bytes", async () => {
    const a = node(PEER_A, 100, false);
    const b = node(PEER_A, 100, false);
    await write(a, (tx) => {
      tx.insert(NOTES, N1, row({ id: "n1", title: "t" }));
      tx.doc(NOTES, N1, edit(1));
    });
    await write(b, (tx) => {
      tx.insert(NOTES, N1, row({ id: "n1", title: "t" }));
      tx.doc(NOTES, N1, edit(99));
    });
    expect(tableDigests(b.engine.state())).toEqual(tableDigests(a.engine.state()));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    expect(tableDigests(b.engine.state())).not.toEqual(tableDigests(a.engine.state()));
  });
});

describe("a lineage cell that joins outside an event (RFC-0023 §5.3, §16.1)", () => {
  /**
   * B replaces A's lineage and edits on it; R holds B's two events but not A's genesis, so B's
   * replace hangs off nothing and both its entries are orphaned. A's record then reaches R with no
   * event — a snapshot page or a repair record — carrying A's genesis in its lineage cell.
   */
  const scenario = async () => {
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const created = await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    const g1 = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    for (const event of [created, g1]) (await b.engine.receive({ event })).unwrap();
    const g2 = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const e2 = await write(b, (tx) => tx.doc(NOTES, N1, edit(3, lineageAt(b))));
    const r = node(PEER_C, 50, true);
    (await r.engine.receiveBatch([g2, e2].map((event) => ({ event })))).unwrap();
    expect(lineageAt(r)).toBeUndefined();
    expect((await log(r)).map((e) => e.state)).toEqual(["orphaned", "orphaned"]);
    return { a, r, winner: deriveLineage(PEER_B, seq(1), 0) };
  };

  const relabelled = async (r: Node, winner: LineageId) => {
    expect(lineageAt(r)).toBe(winner);
    expect((await log(r)).map((e) => e.state)).toEqual(["tail", "tail"]);
    const [head] = (await r.engine.docHeads()).unwrap();
    expect(head).toMatchObject({ lineage: winner, tailCount: 2 });
  };

  test("a parent that lands in a snapshot relabels the doc log at once, not at the next append", async () => {
    const { a, r, winner } = await scenario();
    (await r.engine.installSnapshot(a.engine.snapshot())).unwrap();
    await relabelled(r, winner);
  });

  test("a parent that lands in a repair record relabels the doc log at once", async () => {
    const { a, r, winner } = await scenario();
    (await r.engine.repairRows(NOTES, a.engine.rowRecords(NOTES, [N1]))).unwrap();
    await relabelled(r, winner);
  });

  test("a joiner whose clock runs behind stamps its replace after the genesis a snapshot or repair brought", async () => {
    const a = node(PEER_A, 100, true);
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    a.clock.set(10 * 86_400_000);
    const parent = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    const joiners = [node(PEER_B, 50, true), node(PEER_C, 50, true)];
    const [bySnapshot, byRepair] = joiners;
    (await bySnapshot?.engine.installSnapshot(a.engine.snapshot()))?.unwrap();
    (await byRepair?.engine.repairRows(NOTES, a.engine.rowRecords(NOTES, [N1])))?.unwrap();
    for (const joiner of joiners) {
      expect(lineageAt(joiner)).toBe(deriveLineage(PEER_A, parent.seqNum, 0));
      const child = await write(joiner, (tx) => tx.doc(NOTES, N1, replace(2)));
      expect(compareHlc(child.hlc, parent.hlc)).toBe(1);
      expect(lineageAt(joiner)).toBe(deriveLineage(joiner.engine.peerId, child.seqNum, 0));
    }
  });

  test("a snapshot whose documents have no doc-log entries here adds no heads", async () => {
    const { a } = await scenario();
    const fresh = node(PEER_C, 50, true);
    (await fresh.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect(lineageAt(fresh)).toBe(lineageAt(a));
    expect((await fresh.engine.docHeads()).unwrap()).toEqual([]);
  });

  /** A's record with its lineage cell rewritten as another build would keep it. */
  const foreign = (a: Node, value: CellValue) => {
    const record = getRecord(a.engine.state(), NOTES, N1);
    const cell = record?.cells.get(CONTENT);
    if (record === undefined || cell === undefined) throw new Error("A holds no lineage cell");
    const cells = new Map(record.cells).set(CONTENT, { ...cell, value });
    return { table: NOTES, key: N1, record: { ...record, cells } };
  };
  const untagged = (a: Node) => {
    const cell = getRecord(a.engine.state(), NOTES, N1)?.cells.get(CONTENT)?.value;
    return isJsonArray(cell) ? (cell[1] ?? null) : null;
  };

  test("a snapshot holding a cell of another rule's version is refused whole: nothing joins, nothing is adopted", async () => {
    const { a, r } = await scenario();
    const anchor = [deriveLineage(PEER_A, seq(2), 0), 1, 0, PEER_A];
    for (const [value, version] of [
      // rules 1 and 2 kept an equivocated lineage's first copy (gaps U39)
      [[1, untagged(a)], 1],
      [[2, untagged(a), anchor], 2],
      [[4, untagged(a)], 4],
      [untagged(a), null],
      [deriveLineage(PEER_A, seq(2), 0), null],
    ] as const) {
      const before = r.engine.state();
      const snapshot = { rows: [foreign(a, value)], coverage: a.engine.coverage() };
      const refused = await r.engine.installSnapshot(snapshot);
      expect(refused.isErr() && refused.error).toMatchObject({
        _tag: "LineageCellRefused",
        version,
      });
      expect(r.engine.state()).toBe(before);
      expect(r.engine.coverage().synced.get(PEER_A)).toBeUndefined();
      expect(lineageAt(r)).toBeUndefined();
    }
  });

  test("a repair record holding a cell of another rule's version is refused before it joins", async () => {
    const { a, r } = await scenario();
    const before = r.engine.state();
    const refused = await r.engine.repairRows(NOTES, [foreign(a, [2, untagged(a)])]);
    expect(refused.isErr() && refused.error.version).toBe(2);
    expect(r.engine.state()).toBe(before);
  });

  test("the boot check reads only tables with a doc column, so the rest stay undecoded", async () => {
    const stateStore = createMemoryStateStore();
    const a = setup(PEER_A, 100, { docs: DOCS, validate, stateStore });
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    /** A table of the cache that has not been decoded: reading any row of it fails the test. */
    class Undecoded extends Map<RowKey, RowRecord> {
      override get(): never {
        throw new Error("a table with no doc column was decoded at boot");
      }
      override [Symbol.iterator](): never {
        return this.get();
      }
      override entries(): never {
        return this.get();
      }
    }
    const lazy: typeof stateStore = {
      ...stateStore,
      loadAll: async () =>
        (await stateStore.loadAll()).map((state) => new Map([...state, [PLAIN, new Undecoded()]])),
    };
    const booted = await openEngine({
      peerId: PEER_A,
      clock: fakeClock(500),
      store: a.store,
      stateStore: lazy,
      docs: DOCS,
      validate,
    });
    expect(booted.isOk()).toBe(true);
  });

  test("unreadable state holding rows a snapshot installed is refused, not rebuilt without them (U22)", async () => {
    const a = setup(PEER_A, 100, { docs: DOCS, validate });
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    const stateStore = createMemoryStateStore();
    const r = setup(PEER_B, 200, { docs: DOCS, validate, stateStore });
    (await r.engine.installSnapshot(a.engine.snapshot())).unwrap();
    // the rows came as state: r's log holds none of the events behind them
    expect(r.engine.coverage().floor?.get(PEER_A)).toBe(seq(2));
    (await stateStore.commit([foreign(a, untagged(a))], r.engine.coverage())).unwrap();
    const errors: EngineError[] = [];
    const booted = await openEngine({
      peerId: PEER_B,
      clock: fakeClock(500),
      store: r.store,
      stateStore,
      docs: DOCS,
      validate,
      onError: (e) => void errors.push(e),
    });
    expect(booted.isErr() && booted.error._tag).toBe("StateCorrupt");
    expect(booted.isErr() && booted.error.message).toContain("installed from a snapshot");
    expect(errors.map((e) => e._tag)).toEqual(["LineageCellRefused"]);
    // nothing was cleared: a rebuild from this log would have emptied the table without a word
    expect((await stateStore.loadAll()).unwrap().get(NOTES)?.has(N1)).toBe(true);
  });

  test("persisted state holding another rule's cell is refused, said, and rebuilt from the log", async () => {
    const stateStore = createMemoryStateStore();
    const a = setup(PEER_A, 100, { docs: DOCS, validate, stateStore });
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    const held = foreign(a, untagged(a));
    (await stateStore.commit([held], a.engine.coverage())).unwrap();
    const errors: EngineError[] = [];
    const booted = (
      await openEngine({
        peerId: PEER_A,
        clock: fakeClock(500),
        store: a.store,
        stateStore,
        docs: DOCS,
        validate,
        onError: (e) => void errors.push(e),
      })
    ).unwrap();
    expect(errors.map((e) => e._tag)).toEqual(["LineageCellRefused"]);
    expect(docLineage(getRecord(booted.state(), NOTES, N1), CONTENT)).toBe(
      deriveLineage(PEER_A, seq(2), 0),
    );
    const cached = (await stateStore.loadAll()).unwrap();
    expect(cached.get(NOTES)?.get(N1)?.cells.get(CONTENT)?.value).toEqual(
      getRecord(a.engine.state(), NOTES, N1)?.cells.get(CONTENT)?.value,
    );
  });

  test("state an earlier rule kept (a cell tagged 1 or 2) is rebuilt from the log under rule 3 (gaps U39)", async () => {
    for (const earlier of [1, 2] as const) {
      const stateStore = createMemoryStateStore();
      const a = setup(PEER_A, 100, { docs: DOCS, validate, stateStore });
      await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
      await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
      const anchor = [deriveLineage(PEER_A, seq(2), 0), 1, 0, PEER_A];
      const kept = earlier === 1 ? [1, untagged(a)] : [2, untagged(a), anchor];
      (await stateStore.commit([foreign(a, kept)], a.engine.coverage())).unwrap();
      const errors: EngineError[] = [];
      const booted = (
        await openEngine({
          peerId: PEER_A,
          clock: fakeClock(500),
          store: a.store,
          stateStore,
          docs: DOCS,
          validate,
          onError: (e) => void errors.push(e),
        })
      ).unwrap();
      expect(errors).toMatchObject([{ _tag: "LineageCellRefused", version: earlier }]);
      const rebuilt = getRecord(booted.state(), NOTES, N1)?.cells.get(CONTENT)?.value;
      expect(isJsonArray(rebuilt) && rebuilt[0]).toBe(LINEAGE_RULE);
      expect(docLineage(getRecord(booted.state(), NOTES, N1), CONTENT)).toBe(
        deriveLineage(PEER_A, seq(2), 0),
      );
    }
  });
});

describe("a lineage cell stays bounded however often a document is replaced (gaps U21)", () => {
  const DAY = 86_400_000;
  const cellOf = (n: Node) => getRecord(n.engine.state(), NOTES, N1)?.cells.get(CONTENT)?.value;
  const genesesIn = (value: CellValue | undefined) =>
    isJsonArray(value) ? Object.keys(value[1] ?? {}).length : 0;

  test("a replace past the settle window names its anchor, and every peer trims alike", async () => {
    const a = node(PEER_A, 100, true);
    const events: SyncEvent[] = [
      await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" }))),
    ];
    const sizes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      a.clock.set(100 + (i + 1) * 31 * DAY);
      events.push(await write(a, (tx) => tx.doc(NOTES, N1, replace(i))));
      sizes.push(genesesIn(cellOf(a)));
    }
    // from the second replace on, each settles the walk at the one before it
    expect(sizes).toEqual([1, ...Array.from({ length: 11 }, () => 1)]);
    const [, , second] = events;
    const anchor = second?.changes[0]?.kind === "doc" ? second.changes[0].settles : undefined;
    expect(anchor?.lineage).toBe(deriveLineage(PEER_A, seq(2), 0));
    const last = events.at(-1)?.seqNum;
    expect(docLineage(getRecord(a.engine.state(), NOTES, N1), CONTENT)).toBe(
      last === undefined ? undefined : deriveLineage(PEER_A, last, 0),
    );
    // a peer folding the same events backwards holds the same record, byte for byte
    const b = node(PEER_B, 50, true);
    for (const event of [...events].reverse()) (await b.engine.receive({ event })).unwrap();
    expect(getRecord(b.engine.state(), NOTES, N1)).toEqual(getRecord(a.engine.state(), NOTES, N1));
  });

  test("inside the window nothing settles, so a late first replace still wins", async () => {
    const a = node(PEER_A, 100, true);
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    for (let i = 0; i < 4; i += 1) {
      a.clock.set(100 + (i + 1) * DAY);
      const replaced = await write(a, (tx) => tx.doc(NOTES, N1, replace(i)));
      const change = replaced.changes[0];
      expect(change?.kind === "doc" && change.settles).toBeUndefined();
    }
    expect(genesesIn(cellOf(a))).toBe(4);
  });

  test("a window shorter than an hour is taken as an hour", async () => {
    const a = setup(PEER_A, 100, {
      docs: DOCS,
      validate,
      docAdapters: new Set([LORO]),
      lineageSettleAfter: Temporal.Duration.from({ seconds: 1 }),
    });
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    a.clock.set(100 + DAY);
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    a.clock.set(100 + DAY + 60_000);
    const sibling = await write(a, (tx) => tx.doc(NOTES, N1, replace(2)));
    const change = sibling.changes[0];
    expect(change?.kind === "doc" && change.settles).toBeUndefined();
  });

  test("the window is the engine's to set", async () => {
    const a = setup(PEER_A, 100, {
      docs: DOCS,
      validate,
      docAdapters: new Set([LORO]),
      lineageSettleAfter: Temporal.Duration.from({ hours: 1 }),
    });
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    a.clock.set(100 + DAY);
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    a.clock.set(100 + 2 * DAY);
    const settling = await write(a, (tx) => tx.doc(NOTES, N1, replace(2)));
    const change = settling.changes[0];
    expect(change?.kind === "doc" && change.settles?.lineage).toBe(
      deriveLineage(PEER_A, seq(2), 0),
    );
  });

  test("a window in weeks or months is measured, not refused", async () => {
    for (const given of [{ weeks: 6 }, { months: 1 }, { years: 1 }]) {
      const a = setup(PEER_A, 100, {
        docs: DOCS,
        validate,
        docAdapters: new Set([LORO]),
        lineageSettleAfter: Temporal.Duration.from(given),
      });
      await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
      a.clock.set(100 + DAY);
      await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
      a.clock.set(100 + 2 * DAY);
      const inside = (await write(a, (tx) => tx.doc(NOTES, N1, replace(2)))).changes[0];
      expect(inside?.kind === "doc" && inside.settles).toBeUndefined();
      a.clock.set(100 + 400 * DAY);
      const past = (await write(a, (tx) => tx.doc(NOTES, N1, replace(3)))).changes[0];
      expect(past?.kind === "doc" && past.settles?.lineage).toBe(deriveLineage(PEER_A, seq(3), 0));
    }
  });
});

describe("a lineage read back for a restore (RFC-0023 §5.3)", () => {
  const DOC = { table: NOTES, key: N1, column: CONTENT };

  test("whole on the device that wrote it, and lost where a snapshot install adopted its history", async () => {
    const a = node(PEER_A, 100, true);
    await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    await write(a, (tx) => tx.doc(NOTES, N1, edit(1)));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(2)));
    await write(a, (tx) => tx.doc(NOTES, N1, replace(3)));
    const first = deriveLineage(PEER_A, seq(3), 0);
    const held = async (n: Node, lineage: LineageId | undefined) =>
      (await n.engine.docLineageLog(DOC, lineage)).unwrap();
    expect((await held(a, undefined)).lost).toBe(0);
    expect((await held(a, undefined)).updates).toHaveLength(1);
    expect((await held(a, first)).lost).toBe(0);

    // a joiner takes state: the cell names both geneses, and no event of either reached it
    const c = node(PEER_C, 300, true);
    (await c.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect((await held(c, first)).lost).toBe(1);
    expect((await held(c, undefined)).lost).toBe(1);
  });

  test("lost on a joiner when an anchor trimmed the lineage's genesis and its event never came", async () => {
    const DAY = 86_400_000;
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 50, true);
    const c = node(PEER_C, 300, true);
    const held = async (n: Node, lineage: LineageId | undefined) =>
      (await n.engine.docLineageLog(DOC, lineage)).unwrap();
    const send = async (to: Node, event: SyncEvent) =>
      (await to.engine.receive({ event })).unwrap();
    await send(b, await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" }))));
    a.clock.set(100 + DAY);
    await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    // B replaces the root it holds: a sibling of A's first replace, which loses to it
    b.clock.set(100 + 1.5 * DAY);
    const sibling = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const orphan = sibling.changes[0]?.kind === "doc" ? sibling.changes[0].lineage : undefined;
    await send(a, sibling);
    a.clock.set(100 + 2 * DAY);
    await write(a, (tx) => tx.doc(NOTES, N1, replace(3)));
    // settles at the replace of day 2, so the sibling, stamped before it, leaves the cell
    a.clock.set(100 + 40 * DAY);
    await write(a, (tx) => tx.doc(NOTES, N1, replace(4)));
    expect(
      readLineageCell(
        getRecord(a.engine.state(), NOTES, N1)?.cells.get(CONTENT)?.value,
      ).geneses.some((g) => g.lineage === orphan),
    ).toBe(false);
    expect((await held(a, orphan)).lost).toBe(0);
    // B, still apart, keeps editing what it replaced
    b.clock.set(100 + 41 * DAY);
    const late = await write(b, (tx) => tx.doc(NOTES, N1, edit(5, orphan)));

    // a joiner takes A's state, then only B's late edit: the replace's snapshot never reached it
    (await c.engine.installSnapshot(a.engine.snapshot())).unwrap();
    await send(c, late);
    const read = await held(c, orphan);
    expect(read.updates).toHaveLength(1);
    expect(read.lost).toBeGreaterThan(0);
  });
});
