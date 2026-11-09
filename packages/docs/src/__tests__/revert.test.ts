import {
  CannotRevert,
  createEngine,
  createMemoryEventStore,
  createValidator,
} from "@syncmesh/engine";
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
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createDocuments } from "../index.js";
import { OPLOG_ID, append, oplog, values, type OpLog } from "../testing/index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const CONTENT = "content" as ColumnName;
const ID = "id" as ColumnName;
const TITLE = "title" as ColumnName;
const N1 = "n1" as RowKey;
const EDIT = "notes.edit" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const W1 = parsePartitionKey("workspace:w1").unwrap();
const DOC = { table: NOTES, key: N1, column: CONTENT };
const DOCS = new Map([[NOTES, new Map([[CONTENT, OPLOG_ID]])]]);
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), content: t.blob().nullable() },
      partition: partition("workspace"),
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});
const validate = createValidator({ schema, grantFor: null, docs: DOCS });

/** An engine that keeps its last writes revertable, with the document runtime over it. */
function node(n: number) {
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
    undoDepth: 8,
  });
  const documents = createDocuments({
    engine,
    adapters: [oplog()],
    docs: DOCS,
    procedure: EDIT,
    autoMaterialise: false,
    now,
  });
  return { engine, documents };
}
type Node = ReturnType<typeof node>;

const insertNote = async (n: Node) =>
  (
    await n.engine.mutate(
      EDIT,
      (tx) =>
        tx.insert(
          NOTES,
          N1,
          new Map([
            [ID, "n1"],
            [TITLE, "t"],
          ]),
        ),
      { partition: W1 },
    )
  ).unwrap();

/** Writes `words` into the document as one event of its own. */
const write = async (n: Node, ...words: readonly string[]) =>
  (
    await n.documents.mutate(EDIT, (_tx, docs) =>
      docs.change<OpLog>(DOC, (doc) => {
        for (const word of words) append(doc, word);
      }),
    )
  ).unwrap();

/** Every event `from` holds that `to` lacks, folded into `to`. */
const deliver = async (from: Node, to: Node) => {
  const theirs = (await from.engine.eventsSince(to.engine.coverage().synced)).unwrap();
  (await to.engine.receiveBatch(theirs)).unwrap();
};

/** The document's values, sorted: two replicas' values interleave by replica id. */
const read = async (n: Node) => {
  const doc = (await n.documents.open<OpLog>(DOC)).unwrap();
  const held = [...values(doc.value)].sort();
  (await doc.close()).unwrap();
  return held;
};

describe("a revert takes a write's documents back too (RFC-0023 §9, E30 P6)", () => {
  test("a write of document updates alone is reverted, and a colleague's later edit stands", async () => {
    const a = node(1);
    const b = node(2);
    await insertNote(a);
    await write(a, "kept");
    const action = await write(a, "mine");
    await deliver(a, b);
    // b writes after a's edit, on top of it
    await write(b, "theirs");
    await deliver(b, a);
    expect(await read(a)).toEqual(["kept", "mine", "theirs"]);
    // without a runtime the engine still refuses it, and the write stays revertable
    const bare = await a.engine.revert(action.id);
    expect(bare.isErr() && bare.error._tag).toBe("CannotRevert");
    const reverted = (await a.documents.revert(action.id)).unwrap();
    expect(reverted.skipped).toEqual([]);
    expect(reverted.event?.changes.map((c) => c.kind)).toEqual(["doc"]);
    expect(await read(a)).toEqual(["kept", "theirs"]);
    // the compensation is an ordinary edit: the colleague reads the same document
    await deliver(a, b);
    expect(await read(b)).toEqual(["kept", "theirs"]);
  });

  test("reverting the revert is redo", async () => {
    const a = node(3);
    await insertNote(a);
    const action = await write(a, "one");
    const undone = (await a.documents.revert(action.id)).unwrap();
    expect(await read(a)).toEqual([]);
    const redo = undone.event ?? panicked();
    (await a.documents.revert(redo.id)).unwrap();
    expect(await read(a)).toEqual(["one"]);
  });

  test("a write of a row and a document is taken back as one event", async () => {
    const a = node(4);
    await insertNote(a);
    const action = (
      await a.documents.mutate(
        EDIT,
        (tx, docs) => {
          tx.update(NOTES, N1, new Map([[TITLE, "renamed"]]));
          docs.change<OpLog>(DOC, (doc) => append(doc, "with the rename"));
        },
        { partition: W1 },
      )
    ).unwrap();
    const reverted = (await a.documents.revert(action.id)).unwrap();
    expect(reverted.event?.changes.map((c) => c.kind).sort()).toEqual(["doc", "update"]);
    expect(reverted.skipped).toEqual([]);
    expect(a.engine.state().get(NOTES)?.get(N1)?.cells.get(TITLE)?.value).toBe("t");
    expect(await read(a)).toEqual([]);
  });

  test("a replace is taken back by a genesis bringing the version it ended", async () => {
    const a = node(5);
    await insertNote(a);
    await write(a, "before");
    const template = oplog().create(99n);
    append(template, "template");
    const replaced = (await a.documents.replace(DOC, oplog().snapshot(template))).unwrap();
    expect(await read(a)).toEqual(["template"]);
    const reverted = (await a.documents.revert(replaced.id)).unwrap();
    const [change] = reverted.event?.changes ?? [];
    expect(change?.kind === "doc" && change.genesis).toBe(true);
    expect(await read(a)).toEqual(["before"]);
    // the template's version is a lineage that lost, still listed
    expect((await a.documents.lineages(DOC)).unwrap()).toHaveLength(3);
  });

  test("an edit on a lineage a replace has since ended is superseded, and nothing is written", async () => {
    const a = node(6);
    await insertNote(a);
    const action = await write(a, "old");
    const fresh = oplog().create(98n);
    append(fresh, "new");
    (await a.documents.replace(DOC, oplog().snapshot(fresh))).unwrap();
    const reverted = (await a.documents.revert(action.id)).unwrap();
    expect(reverted.event).toBeUndefined();
    expect(reverted.skipped).toEqual([{ ...DOC, reason: "superseded" }]);
    expect(await read(a)).toEqual(["new"]);
  });

  test("a compensation the runtime cannot make reverts nothing and leaves the write revertable", async () => {
    const a = node(7);
    await insertNote(a);
    const action = await write(a, "x");
    const refused = await a.engine.revert(action.id, (_changes, eventId) =>
      Promise.resolve(Result.err(new CannotRevert({ eventId, message: "no adapter here" }))),
    );
    expect(refused.isErr() && refused.error.message).toBe("no adapter here");
    expect(a.engine.canRevert(action.id)).toBe(true);
    (await a.documents.revert(action.id)).unwrap();
    expect(await read(a)).toEqual([]);
  });
});

const panicked = (): never => {
  throw new Error("expected a value");
};
