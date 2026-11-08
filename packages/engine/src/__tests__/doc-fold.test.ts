import {
  getRecord,
  docLineage,
  parseAdapterId,
  parsePartitionKey,
  type ColumnName,
  type LineageId,
  type PeerId,
  type SyncEvent,
} from "@syncmesh/kernel";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { deriveLineage } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import type { DocWrite } from "../tx.js";

import { tableDigests } from "../digest.js";
import { docDigests } from "../doc-log.js";
import { createValidator } from "../validate.js";
import {
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  PEER_C,
  column,
  procedure,
  row,
  seq,
  setup,
} from "./fixtures.js";

const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([[NOTES, new Map<ColumnName, typeof LORO>([[CONTENT, LORO]])]]);
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
