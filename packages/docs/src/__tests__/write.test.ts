import { sha256 } from "@noble/hashes/sha2.js";
import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import {
  createHlcClock,
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
import { bytesToHex, createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { DocLimits } from "../adapter.js";
import type { DocBlobs } from "../blobs.js";

import { createDocuments } from "../index.js";
import { OPLOG_ID, append, oplog, values, type OpLog } from "../testing/index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const GHOSTS = "ghosts" as TableName;
const CONTENT = "content" as ColumnName;
const ID = "id" as ColumnName;
const N1 = "n1" as RowKey;
const N2 = "n2" as RowKey;
const EDIT = "notes.edit" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const W1 = parsePartitionKey("workspace:w1").unwrap();
const DOC = { table: NOTES, key: N1, column: CONTENT };
const DOC2 = { table: NOTES, key: N2, column: CONTENT };
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

/** A content-addressed store several nodes share, as a relay would carry their blobs. */
function sharedBlobs() {
  const held = new Map<string, Uint8Array>();
  const blobs: DocBlobs = {
    put: async (bytes) => {
      const hash = bytesToHex(sha256(bytes));
      held.set(hash, bytes);
      return Result.ok(hash);
    },
    fetch: async (hash) => {
      const bytes = held.get(hash);
      return bytes === undefined ? Result.err(new Error("no carrier holds it")) : Result.ok(bytes);
    },
  };
  return { held, blobs };
}

interface NodeOptions {
  readonly limits?: Partial<DocLimits>;
  readonly blobs?: DocBlobs;
}

/** An engine with the doc column declared and the document runtime over it, on `oplog@1`. */
function node(n: number, { limits = {}, blobs }: NodeOptions = {}) {
  const identity = createIdentity(seed(n)).unwrap();
  let ms = 1_700_000_000_000 + n * 1000;
  const now = () => Temporal.Instant.fromEpochMilliseconds((ms += 1));
  const engine = createEngine({
    peerId: identity.peerId,
    clock: createHlcClock({ now }),
    store: createMemoryEventStore(),
    validate,
    docs: DOCS,
    docAdapters: new Set([OPLOG_ID]),
  });
  const documents = createDocuments({
    engine,
    adapters: [oplog(limits)],
    docs: DOCS,
    procedure: EDIT,
    pacing: FAST,
    autoMaterialise: false,
    now,
    ...(blobs !== undefined && { blobs }),
  });
  return { identity, engine, documents };
}
type Node = ReturnType<typeof node>;

const row = (key: RowKey) => new Map([[ID, key]]);

const insertNote = async (n: Node, key = N1) =>
  (
    await n.engine.mutate(EDIT, (tx) => tx.insert(NOTES, key, row(key)), { partition: W1 })
  ).unwrap();

/** Every event `from` holds that `to` lacks, folded into `to`. */
const deliver = async (from: Node, to: Node) => {
  const theirs = (await from.engine.eventsSince(to.engine.coverage().synced)).unwrap();
  (await to.engine.receiveBatch(theirs)).unwrap();
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A snapshot of a fresh `oplog@1` document holding `words`. */
function snapshotOf(...words: readonly string[]) {
  const adapter = oplog();
  const doc = adapter.create(99n);
  for (const word of words) append(doc, word);
  return adapter.snapshot(doc);
}

const read = async (n: Node, address = DOC) => {
  const doc = (await n.documents.open<OpLog>(address)).unwrap();
  const read = values(doc.value);
  (await doc.close()).unwrap();
  return read;
};

describe("a write of rows and documents is one event (RFC-0023 §4.3)", () => {
  test("an insert and an edit of the new row's document land in one event, on every peer", async () => {
    const a = node(1);
    const b = node(2);
    const event = (
      await a.documents.mutate(
        EDIT,
        (tx, docs) => {
          tx.insert(NOTES, N1, row(N1));
          docs.change<OpLog>(DOC, (doc) => append(doc, "hello"));
        },
        { partition: W1 },
      )
    ).unwrap();
    expect(event.changes.map((c) => c.kind)).toEqual(["insert", "doc"]);
    await deliver(a, b);
    expect(b.engine.rowsIn(NOTES, W1).has(N1)).toBe(true);
    expect(await read(b)).toEqual(["hello"]);
    // the write's own replica sent everything it held: the pacing has nothing left to send
    await settle(40);
    expect((await a.engine.docLog()).unwrap()).toHaveLength(1);
  });

  test("an open handle's unflushed edits ride the write, and two documents share it", async () => {
    const a = node(3);
    await insertNote(a);
    await insertNote(a, N2);
    const open = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(open.value, "typed");
    const event = (
      await a.documents.mutate(EDIT, (_tx, docs) => {
        docs.change<OpLog>(DOC, (doc) => append(doc, "written"));
        docs.change<OpLog>(DOC2, (doc) => append(doc, "elsewhere"));
      })
    ).unwrap();
    expect(event.changes.filter((c) => c.kind === "doc")).toHaveLength(2);
    expect(event.partition).toBe(W1);
    expect(values(open.value)).toEqual(["typed", "written"]);
    expect(open.status()).toBe("current");
    (await open.close()).unwrap();
    expect((await a.engine.docLog()).unwrap()).toHaveLength(2);
    expect(await read(a, DOC2)).toEqual(["elsewhere"]);
  });

  test("a refused write publishes none of it, and the replica it edited is invalidated", async () => {
    const a = node(4);
    await insertNote(a);
    const open = (await a.documents.open<OpLog>(DOC)).unwrap();
    const written = await a.documents.mutate(EDIT, (tx, docs) => {
      tx.insert(GHOSTS, N2, row(N2)); // no such table: the validator refuses the whole event
      docs.change<OpLog>(DOC, (doc) => append(doc, "never sent"));
    });
    expect(written.isErr()).toBe(true);
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
    expect(open.status()).toBe("invalidated");
    expect((await open.flush()).isErr()).toBe(true);
    await settle(40);
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
    expect(await read(a)).toEqual([]);
  });

  test("one write cannot both edit and replace a document, and writes nothing when asked to", async () => {
    const a = node(5);
    await insertNote(a);
    const written = await a.documents.mutate(EDIT, (_tx, docs) => {
      docs.change<OpLog>(DOC, (doc) => append(doc, "edit"));
      docs.replace(DOC, snapshotOf("replace"));
    });
    expect(written.isErr() && written.error._tag).toBe("DocWriteConflict");
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
  });
});

describe("replace() starts a new lineage (RFC-0023 §5.3)", () => {
  test("a replace wins over the edits before it, invalidates the open handle, and reaches peers", async () => {
    const a = node(6);
    const b = node(7);
    await insertNote(a);
    const open = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(open.value, "draft");
    (await open.flush()).unwrap();
    const event = (await a.documents.replace(DOC, snapshotOf("template"))).unwrap();
    const genesis = event.changes[0];
    expect(genesis?.kind === "doc" && genesis.genesis).toBe(true);
    expect(open.status()).toBe("invalidated");
    expect(await read(a)).toEqual(["template"]);
    await deliver(a, b);
    expect(await read(b)).toEqual(["template"]);
  });

  test("a snapshot the adapter cannot read, or past the inline bound with no blob store, is refused", async () => {
    const a = node(8, { limits: { maxUpdateBytes: 64 } });
    await insertNote(a);
    const garbage = await a.documents.replace(DOC, new TextEncoder().encode("not oplog"));
    expect(garbage.isErr() && garbage.error._tag).toBe("UpdateRejected");
    const big = await a.documents.replace(DOC, snapshotOf("x".repeat(200)));
    expect(big.isErr() && big.error._tag).toBe("UpdateTooLarge");
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
  });
});

describe("a lineage that lost is listed, read and brought back (RFC-0023 §5.3)", () => {
  test("two replaces of one version: the first wins, the other is readable and restorable", async () => {
    const a = node(9);
    const b = node(10);
    await insertNote(a);
    await deliver(a, b);
    (await a.documents.replace(DOC, snapshotOf("ada's"))).unwrap();
    (await b.documents.replace(DOC, snapshotOf("bo's"))).unwrap();
    // bo keeps typing on his own lineage before he hears of ada's
    (
      await b.documents.mutate(EDIT, (_tx, docs) =>
        docs.change<OpLog>(DOC, (doc) => append(doc, "bo's edit")),
      )
    ).unwrap();
    await deliver(a, b);
    await deliver(b, a);
    expect(await read(a)).toEqual(await read(b));
    expect(await read(a)).toEqual(["ada's"]);

    const listed = (await b.documents.lineages(DOC)).unwrap();
    const replaced = listed.filter((l) => l.lineage !== undefined);
    expect(replaced).toHaveLength(2);
    const lost = replaced.find((l) => !l.winning);
    expect(lost?.updates).toBe(2);
    expect(listed.filter((l) => l.winning)).toHaveLength(1);

    const version = (await b.documents.openLineage<OpLog>(DOC, lost?.lineage)).unwrap();
    expect([...values(version.value)].sort()).toEqual(["bo's", "bo's edit"]);
    expect(version.failed + version.missing).toBe(0);

    (await b.documents.restore(DOC, lost?.lineage)).unwrap();
    await deliver(b, a);
    expect([...(await read(a))].sort()).toEqual(["bo's", "bo's edit"]);
    expect([...(await read(b))].sort()).toEqual(["bo's", "bo's edit"]);
    // ada's version is the one listed as lost now
    const after = (await a.documents.lineages(DOC)).unwrap();
    const winner = after.find((l) => l.winning);
    expect(winner?.parent).toBe(replaced.find((l) => l.winning)?.lineage);
  });
});

describe("a burst past the inline bound travels as a blob (RFC-0023 §5.4, D18)", () => {
  test("with a blob store it goes by reference, and a peer applies it open or closed", async () => {
    const { blobs, held } = sharedBlobs();
    const a = node(11, { limits: { maxUpdateBytes: 64 }, blobs });
    const b = node(12, { limits: { maxUpdateBytes: 64 }, blobs });
    await insertNote(a);
    await deliver(a, b);
    const onB = (await b.documents.open<OpLog>(DOC)).unwrap();
    let heard = 0;
    onB.subscribe(() => (heard += 1));
    const onA = (await a.documents.open<OpLog>(DOC)).unwrap();
    const long = "y".repeat(200);
    append(onA.value, long);
    const event = (await onA.flush()).unwrap();
    const change = event?.changes[0];
    expect(change?.kind === "doc" && change.update.blob?.size).toBeGreaterThan(64);
    expect(held.size).toBe(1);
    await deliver(a, b);
    await settle(10);
    expect(values(onB.value)).toEqual([long]);
    expect(onB.status()).toBe("current");
    expect(heard).toBeGreaterThan(0);
    (await onB.close()).unwrap();
    // closed and reopened: the tail's reference is fetched as it loads, and it materialises
    expect(await read(b)).toEqual([long]);
    const done = (await b.documents.materialise(DOC)).unwrap();
    expect(done.covered).toBe(1);
  });

  test("a peer no carrier serves stays behind, and one with no store refuses the burst", async () => {
    const { blobs, held } = sharedBlobs();
    const a = node(13, { limits: { maxUpdateBytes: 64 }, blobs });
    const b = node(14, { limits: { maxUpdateBytes: 64 }, blobs });
    await insertNote(a);
    await deliver(a, b);
    const onA = (await a.documents.open<OpLog>(DOC)).unwrap();
    append(onA.value, "z".repeat(200));
    (await onA.flush()).unwrap();
    held.clear();
    await deliver(a, b);
    const onB = (await b.documents.open<OpLog>(DOC)).unwrap();
    expect(onB.status()).toBe("behind");
    expect(values(onB.value)).toEqual([]);

    const bare = node(15, { limits: { maxUpdateBytes: 64 } });
    await insertNote(bare);
    const doc = (await bare.documents.open<OpLog>(DOC)).unwrap();
    append(doc.value, "z".repeat(200));
    const refused = await doc.flush();
    expect(refused.isErr() && refused.error._tag).toBe("UpdateTooLarge");
    expect((await bare.engine.docLog()).unwrap()).toEqual([]);
  });
});
