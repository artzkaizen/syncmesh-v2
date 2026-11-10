import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import {
  createHlcClock,
  hlcOf,
  parsePartitionKey,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Result } from "@syncmesh/result";
import { partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { DocLimits } from "../adapter.js";

import { CheckpointRefused, HandleInvalidated, UpdateTooLarge, createDocuments } from "../index.js";
import { OPLOG_ID, append, checkAdapter, oplog, values, type OpLog } from "../testing/index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const CONTENT = "content" as ColumnName;
const N1 = "n1" as RowKey;
const EDIT = "notes.edit" as Procedure;
const ID = "id" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const W1 = parsePartitionKey("workspace:w1").unwrap();
const DOC = { table: NOTES, key: N1, column: CONTENT };
const DOCS = new Map([[NOTES, new Map([[CONTENT, OPLOG_ID]])]]);
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), content: t.blob().nullable() },
      partition: partition("workspace"),
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});
const validate = createValidator({ schema, grantFor: null, docs: DOCS });
const FAST = {
  idle: Temporal.Duration.from({ milliseconds: 5 }),
  max: Temporal.Duration.from({ milliseconds: 20 }),
};

/** An engine with the doc column declared and the document runtime over it, on `oplog@1`. */
function node(n: number, limits: Partial<DocLimits> = {}, adapter = true) {
  const identity = createIdentity(seed(n)).unwrap();
  let ms = 1_700_000_000_000 + n * 1000;
  const now = () => Temporal.Instant.fromEpochMilliseconds((ms += 1));
  const engine = createEngine({
    peerId: identity.peerId,
    clock: createHlcClock({ now }),
    store: createMemoryEventStore(),
    validate,
    docs: DOCS,
    ...(adapter && { docAdapters: new Set([OPLOG_ID]) }),
  });
  const documents = createDocuments({
    engine,
    adapters: adapter ? [oplog(limits)] : [],
    docs: DOCS,
    procedure: EDIT,
    pacing: FAST,
    autoMaterialise: false,
    now,
  });
  return { identity, engine, documents };
}
type Node = ReturnType<typeof node>;

const insertNote = async (n: Node) =>
  (
    await n.engine.mutate(EDIT, (tx) => tx.insert(NOTES, N1, new Map([[ID, "n1"]])), {
      partition: W1,
    })
  ).unwrap();

/** Every event `from` holds that `to` lacks, folded into `to`. */
const deliver = async (from: Node, to: Node) => {
  const theirs = (await from.engine.eventsSince(to.engine.coverage().synced)).unwrap();
  (await to.engine.receiveBatch(theirs)).unwrap();
};

/** Waits out the pacing: real timers, as the runtime uses. */
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the document SPI's conformance suite (RFC-0023 §13)", () => {
  const script = {
    edit: (doc: OpLog, n: number) => append(doc, `v${String(n)}`),
    read: (doc: OpLog) => values(doc).join(","),
  };

  test("the reference adapter holds every property", () => {
    const checked = checkAdapter(oplog(), script);
    expect(checked.isOk() || checked.error.failures).toBe(true);
  });

  test("an adapter whose version depends on delivery order is caught", () => {
    const honest = oplog();
    const ordered = {
      ...honest,
      // the applied operations' keys in the order they landed: not a function of the set
      version: (doc: OpLog) => new TextEncoder().encode([...doc.applied.keys()].join(",")),
    };
    const checked = checkAdapter(ordered, script);
    expect(checked.isErr() && checked.error.failures.map((f) => f.check)).toContain("converges");
  });

  test("an adapter that throws on foreign bytes, or forgets a stopped listener, is caught", () => {
    const honest = oplog();
    const brittle = {
      ...honest,
      apply: (doc: OpLog, updates: readonly Uint8Array[]) => {
        if (updates.some((u) => u.length === 0)) throw new Error("no bytes");
        return honest.apply(doc, updates);
      },
      watchLocal: (doc: OpLog, listener: () => void) => {
        doc.listeners.add(listener);
        return () => {};
      },
    };
    const checked = checkAdapter(brittle, script);
    const failed = checked.isErr() ? checked.error.failures.map((f) => f.check) : [];
    expect(failed).toContain("total");
    expect(failed).toContain("watchLocal");
  });

  test("an adapter whose compensation takes nothing back, or cannot be redone, is caught (P6)", () => {
    const honest = oplog();
    const idle = checkAdapter({ ...honest, compensate: () => Result.ok(undefined) }, script);
    expect(idle.isErr() && idle.error.failures.map((f) => f.check)).toContain("compensate");
    // an undo that hides everything, not just the write's own operations
    const greedy = checkAdapter(
      {
        ...honest,
        compensate: (doc: OpLog, _updates: readonly Uint8Array[], replica: bigint) =>
          honest.compensate(doc, [honest.snapshot(doc)], replica),
      },
      script,
    );
    expect(greedy.isErr() && greedy.error.failures.map((f) => f.check)).toContain("compensate");
  });

  test("an adapter that never reports pending operations is caught", () => {
    const checked = checkAdapter({ ...oplog(), pending: () => false }, script);
    expect(checked.isErr() && checked.error.failures.map((f) => f.check)).toContain("pending");
  });
});

describe("the document runtime over the SPI", () => {
  test("a burst of local commits is paced into one doc change", async () => {
    const a = node(1);
    await insertNote(a);
    const doc = (await a.documents.open<OpLog>(DOC)).unwrap();
    for (const word of ["one", "two", "three"]) append(doc.value, word);
    // nothing is sent until the burst goes quiet
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
    await settle(60);
    const log = (await a.engine.docLog()).unwrap();
    expect(log).toHaveLength(1);
    expect(log[0]?.state).toBe("tail");
    (await doc.close()).unwrap();
    const reopened = (await a.documents.open<OpLog>(DOC)).unwrap();
    expect(values(reopened.value)).toEqual(["one", "two", "three"]);
  });

  test("a remote doc change reaches an open replica, and its subscribers hear it", async () => {
    const a = node(2);
    const b = node(3);
    await insertNote(a);
    await deliver(a, b);
    const onB = (await b.documents.open<OpLog>(DOC)).unwrap();
    let heard = 0;
    onB.subscribe(() => (heard += 1));
    const onA = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(onA.value, "from a");
    (await onA.flush()).unwrap();
    await deliver(a, b);
    expect(values(onB.value)).toEqual(["from a"]);
    expect(heard).toBe(1);
    // and b's own edit goes back the other way, both replicas converging
    append(onB.value, "from b");
    (await onB.flush()).unwrap();
    await deliver(b, a);
    expect(values(onA.value)).toEqual(values(onB.value));
    expect(onA.status()).toBe("current");
  });

  test("one address is one ref, and flush() sends what the pacing still holds", async () => {
    const a = node(15);
    await insertNote(a);
    const ref = a.documents.ref<OpLog>(DOC);
    expect(a.documents.ref<OpLog>({ ...DOC })).toBe(ref);
    const doc = (await ref.open()).unwrap();
    append(doc.value, "held by the pacing");
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
    await a.documents.flush();
    expect((await a.engine.docLog()).unwrap()).toHaveLength(1);
    // nothing was left for the pacing to send
    await settle(40);
    expect((await a.engine.docLog()).unwrap()).toHaveLength(1);
  });

  test("two opens share one replica; the last close lets it go", async () => {
    const a = node(4);
    await insertNote(a);
    const [one, two] = await Promise.all([
      a.documents.open<OpLog>(DOC),
      a.documents.open<OpLog>(DOC),
    ]);
    expect(one.unwrap().value).toBe(two.unwrap().value);
    (await one.unwrap().close()).unwrap();
    const three = (await a.documents.open<OpLog>(DOC)).unwrap();
    expect(three.value).toBe(two.unwrap().value);
  });

  test("a genesis that moves the lineage invalidates the open handle, and its flush says so", async () => {
    const a = node(5);
    const b = node(6);
    await insertNote(a);
    await deliver(a, b);
    const onB = (await b.documents.open<OpLog>(DOC)).unwrap();
    const snapshot = oplog().snapshot(oplog().create(9n));
    (
      await a.engine.mutate(
        EDIT,
        (tx) =>
          tx.doc(NOTES, N1, {
            column: CONTENT,
            adapter: OPLOG_ID,
            update: { bytes: snapshot },
            genesis: true,
          }),
        { partition: W1 },
      )
    ).unwrap();
    await deliver(a, b);
    expect(onB.status()).toBe("invalidated");
    append(onB.value, "lost");
    const flushed = await onB.flush();
    expect(flushed.isErr() && flushed.error).toBeInstanceOf(HandleInvalidated);
    // reopening is on the new lineage, and the edit made on the old one is not in it
    const reopened = (await b.documents.open<OpLog>(DOC)).unwrap();
    expect(values(reopened.value)).toEqual([]);
  });

  test("a burst past maxUpdateBytes is refused as a value, and nothing of it is sent", async () => {
    const a = node(7, { maxUpdateBytes: 64 });
    await insertNote(a);
    const doc = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(doc.value, "x".repeat(200));
    const flushed = await doc.flush();
    expect(flushed.isErr() && flushed.error).toBeInstanceOf(UpdateTooLarge);
    expect(doc.status()).toBe("invalidated");
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
  });

  test("materialising covers the tail; a reopen reads the snapshot; foreign bytes are failed", async () => {
    const a = node(8);
    await insertNote(a);
    const doc = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(doc.value, "kept");
    (await doc.flush()).unwrap();
    (
      await a.engine.mutate(
        EDIT,
        (tx) =>
          tx.doc(NOTES, N1, {
            column: CONTENT,
            adapter: OPLOG_ID,
            update: { bytes: Uint8Array.of(0xde, 0xad) },
          }),
        { partition: W1 },
      )
    ).unwrap();
    const done = (await a.documents.materialise(DOC)).unwrap();
    expect([done.covered, done.failed]).toEqual([1, 1]);
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["covered", "failed"]);
    const tail = (await a.engine.docTail(DOC)).unwrap();
    expect(tail.snapshot).toBeDefined();
    expect(tail.updates).toEqual([]);
    (await doc.close()).unwrap();
    expect(values((await a.documents.open<OpLog>(DOC)).unwrap().value)).toEqual(["kept"]);
  });

  test("a checkpoint installs on a joiner, and one whose bytes or signer lie is refused", async () => {
    const a = node(10);
    const mallory = node(11);
    await insertNote(a);
    const doc = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(doc.value, "the real text");
    (await doc.flush()).unwrap();
    const made = (await a.documents.checkpoint(DOC, a.identity, hlcOf(Date.now(), 0))).unwrap();
    const c = node(12);
    await c.engine.installSnapshot(a.engine.snapshot());

    const wrongKey = await c.documents.install(
      made.signed.wire,
      mallory.identity.peerId,
      made.snapshot,
      DOC,
    );
    expect(wrongKey.isErr() && wrongKey.error).toBeInstanceOf(CheckpointRefused);
    const tampered = new TextEncoder().encode("[]");
    const badBytes = await c.documents.install(made.signed.wire, a.identity.peerId, tampered, DOC);
    expect(badBytes.isErr() && badBytes.error).toBeInstanceOf(CheckpointRefused);

    (await c.documents.install(made.signed.wire, a.identity.peerId, made.snapshot, DOC)).unwrap();
    expect(values((await c.documents.open<OpLog>(DOC)).unwrap().value)).toEqual(["the real text"]);
  });

  test("a device without the adapter folds the column and cannot open it", async () => {
    const a = node(13);
    const relay = node(14, {}, false);
    await insertNote(a);
    const doc = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(doc.value, "carried");
    (await doc.flush()).unwrap();
    await deliver(a, relay);
    expect((await relay.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["adapter-missing"]);
    const opened = await relay.documents.open<OpLog>(DOC);
    expect(opened.isErr() && opened.error._tag).toBe("AdapterMissing");
  });
});
