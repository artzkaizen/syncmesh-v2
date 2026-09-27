import {
  getRecord,
  lineageOf,
  parseAdapterId,
  parsePartitionKey,
  type ColumnName,
  type LineageId,
  type PeerId,
  type SyncEvent,
} from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
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

const schema = defineSchema({
  partitions: { workspace: {} },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), content: t.blob().nullable() },
      partition: "workspace",
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
const lineageAt = (n: Node) => lineageOf(getRecord(n.engine.state(), NOTES, N1), CONTENT);
const log = async (n: Node) => (await n.engine.docLog()).unwrap();

describe("folding a doc change", () => {
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

  test("the lineage cell and the labels follow the winner, whatever order the geneses land in", async () => {
    // A and B each replace the document while apart; B's is later, and B edits on its lineage
    const a = node(PEER_A, 100, true);
    const b = node(PEER_B, 200, true);
    const created = await write(a, (tx) => tx.insert(NOTES, N1, row({ id: "n1", title: "t" })));
    (await b.engine.receive({ event: created })).unwrap();
    const aReplace = await write(a, (tx) => tx.doc(NOTES, N1, replace(1)));
    const bReplace = await write(b, (tx) => tx.doc(NOTES, N1, replace(2)));
    const bEdit = await write(b, (tx) => tx.doc(NOTES, N1, edit(3, lineageAt(b))));
    const aEdit = await write(a, (tx) => tx.doc(NOTES, N1, edit(4, lineageAt(a))));

    const r = node(PEER_C, 50, true);
    // B's edit arrives before B's genesis: until the genesis lands, it names a lineage nobody chose
    for (const event of [created, bEdit, aReplace, aEdit, bReplace]) {
      (await r.engine.receive({ event })).unwrap();
    }
    const winner = deriveLineage(PEER_B, seq(1), 0);
    expect(lineageAt(r)).toBe(winner);
    const states = new Map((await log(r)).map((e) => [`${e.author[0]}${e.seq}`, e.state]));
    expect(Object.fromEntries(states)).toEqual({
      a2: "orphaned",
      a3: "orphaned",
      b1: "tail",
      b2: "tail",
    });
    expect(bReplace.seqNum).toBe(seq(1));
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
