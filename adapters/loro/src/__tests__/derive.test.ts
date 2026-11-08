import type { BackgroundError } from "@syncmesh/docs";
import type { Runnable } from "@syncmesh/drizzle";
import type { Validator } from "@syncmesh/engine";
import type { CellValue, ColumnName, Row, RowKey } from "@syncmesh/kernel";
import type { DocumentAdapter } from "@syncmesh/schema";
import type { SqlDriver } from "@syncmesh/storage";

import { createDocuments } from "@syncmesh/docs";
import { createLive } from "@syncmesh/drizzle";
import {
  PolicyDenied,
  createEngine,
  createLink,
  createValidator,
  openEngine,
} from "@syncmesh/engine";
import { createHlcClock, hlcOf, parseSeqNum } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Result } from "@syncmesh/result";
import {
  createDerivers,
  drizzleTable,
  from,
  partition,
  syncSchema,
  syncedTables,
} from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores, schemaName } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, signCheckpoint } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { LoroDoc } from "loro-crdt";

import { LORO_ID, loro } from "../index.js";
import { EDIT, FAST, W1, until } from "./fixtures.js";

/** The schema's view of `loro@1`: an id the column declares, read by nothing but the manifest. */
const loroColumn = { id: "loro@1" } satisfies DocumentAdapter<LoroDoc>;

const notes = sqliteTable("notes", {
  id: text().primaryKey(),
  title: text().notNull().default(""),
  wordCount: integer(),
  content: blob({ mode: "buffer" }),
});

const words = (d: LoroDoc) => d.getText("body").toString().split(/\s+/).filter(Boolean).length;

/** RFC-0023 §4.1's schema: the title and the word count are computed from the document. */
const schemaWith = (title: (d: LoroDoc) => string, sealed = false) =>
  syncSchema({
    tables: {
      notes: drizzleTable(notes, {
        partition: partition("workspace", { sealed }),
        merge: { content: loroColumn },
        derive: {
          title: from("content", title),
          wordCount: from("content", words),
        },
        allow: ({ allow }) => ({ $default: allow }),
      }),
    },
  });

const plainTitle = (d: LoroDoc) => d.getText("title").toString();
const schema = schemaWith(plainTitle);
const NOTES = schema.tables.notes.name;
const {
  id: ID,
  content: CONTENT,
  title: TITLE,
  wordCount: WORDS,
} = schema.tables.notes.columnNames;
// SAFETY: a row key is opaque text
const N1 = "n1" as RowKey;
const DOC = { table: NOTES, key: N1, column: CONTENT };
const DOCS = new Map([[NOTES, new Map([[CONTENT, LORO_ID]])]]);

interface NodeOptions {
  readonly adapter?: boolean;
  readonly schema?: typeof schema;
  readonly driver?: SqlDriver;
  readonly validate?: Validator;
}

/** An engine over SQLite stores holding the app's `notes` table, with the document runtime over it. */
async function storedNode(n: number, options: NodeOptions = {}) {
  const using = options.schema ?? schema;
  const identity = createIdentity(seed(n)).unwrap();
  let ms = 1_700_000_000_000 + n * 1000;
  const now = () => Temporal.Instant.fromEpochMilliseconds((ms += 1));
  const driver = options.driver ?? bunSqliteDriver(":memory:");
  const stores = (await openStores(driver, { tables: syncedTables(using) })).unwrap();
  const withAdapter = options.adapter !== false;
  const engine = createEngine({
    peerId: identity.peerId,
    clock: createHlcClock({ now }),
    store: stores.events,
    stateStore: stores.state,
    docStore: stores.docs,
    atomic: stores.atomic,
    validate: options.validate ?? createValidator({ schema: using, grantFor: null, docs: DOCS }),
    docs: DOCS,
    ...(withAdapter && { docAdapters: new Set([LORO_ID]) }),
  });
  const errors: BackgroundError[] = [];
  const documents = createDocuments({
    engine,
    adapters: withAdapter ? [loro()] : [],
    docs: DOCS,
    procedure: EDIT,
    pacing: FAST,
    autoMaterialise: false,
    derive: createDerivers(using),
    now,
    onError: (error) => errors.push(error),
  });
  const row = async () => {
    const [found] = await driver.all(`SELECT title, "wordCount" FROM notes WHERE id = ?`, ["n1"]);
    return found === undefined ? undefined : { title: found[0], words: found[1] };
  };
  return { identity, engine, documents, driver, stores, errors, row, now };
}

type StoredNode = Awaited<ReturnType<typeof storedNode>>;

/** Inserts the note the document lives on; the title is never written — it is derived. */
const insertNote = async (n: StoredNode) =>
  (
    await n.engine.mutate(EDIT, (tx) => tx.insert(NOTES, N1, new Map([[ID, "n1"]])), {
      partition: W1,
    })
  ).unwrap();

/** A live query over the app's `notes` table, read with plain SQL on the node's own connection. */
const titles = (driver: SqlDriver): Runnable<string> => ({
  getSQL: () => sql`select ${notes.title} from ${notes}`,
  // oxlint-disable-next-line unicorn/no-thenable -- a live query awaits its query; this one is SQL text
  then: (onValue, onError) =>
    driver
      .all(`SELECT title FROM notes`)
      .then((rows) => rows.map(([title]) => String(title)))
      .then(onValue, onError),
});

const type = (doc: LoroDoc, title: string, body: string) => {
  doc.getText("title").insert(0, title);
  doc.getText("body").insert(0, body);
  doc.commit();
};

describe("derived columns: every replica computes them (RFC-0023 §16.4)", () => {
  test("a flush writes the title to the local row in its own transaction, and a live query reads it with the edit", async () => {
    const a = await storedNode(1);
    await insertNote(a);
    expect(await a.row()).toEqual({ title: null, words: null });
    const live = createLive(a.engine)(titles(a.driver));
    expect(await live.ready).toEqual(["null"]);
    const seen: string[][] = [];
    live.subscribe((rows) => seen.push([...rows]));

    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Q3 plan", "ship the derive work");
    const event = (await doc.flush()).unwrap();
    // read-your-own-writes: the row holds the title the moment the flush resolves
    expect(await a.row()).toEqual({ title: "Q3 plan", words: 4 });
    expect(await until(() => seen.at(-1)?.[0] === "Q3 plan")).toBe(true);
    // the event carries the document update and nothing else: a derived value never travels
    expect(event?.changes.map((c) => c.kind)).toEqual(["doc"]);
    (await doc.close()).unwrap();
    expect(a.errors).toEqual([]);
    live.release();
  });

  test("a peer computes its own title from the edit it receives — none arrives with it — and digests agree without it", async () => {
    const a = await storedNode(2);
    const b = await storedNode(3);
    await insertNote(a);
    const link = createLink(a.engine, b.engine);
    (await link.catchUp()).unwrap();
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Minutes", "one two three");
    (await doc.flush()).unwrap();
    await link.flush();
    expect(await until(async () => (await b.engine.docLog()).unwrap().length === 1)).toBe(true);
    // b holds no handle: it reads the document from its own log and derives the title (U25)
    expect(await until(async () => (await b.row())?.title === "Minutes")).toBe(true);
    expect(await b.row()).toEqual({ title: "Minutes", words: 3 });
    // nothing derived is a cell, so the row's digest is the same with and without the title
    expect(b.engine.rowDigests(NOTES)).toEqual(a.engine.rowDigests(NOTES));
    expect(a.engine.state().get(NOTES)?.get(N1)?.cells.has(TITLE)).toBe(false);
    expect(b.engine.state().get(NOTES)?.get(N1)?.cells.has(TITLE)).toBe(false);

    // b materialises: the snapshot and the title it computed commit together
    (await b.documents.materialise(DOC)).unwrap();
    expect(await b.row()).toEqual({ title: "Minutes", words: 3 });
    expect(b.engine.rowDigests(NOTES)).toEqual(a.engine.rowDigests(NOTES));
    expect(b.errors).toEqual([]);
    link.close();
  });

  test("a materialisation that read the tail before a flush leaves the flush's newer title in place", async () => {
    const a = await storedNode(7);
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Old", "a");
    (await doc.flush()).unwrap();
    // the materialisation reads its tail now, and commits only after the next flush has landed
    const racing = a.documents.materialise(DOC);
    const title = doc.value.getText("title");
    title.delete(0, title.length);
    title.insert(0, "New");
    doc.value.commit();
    (await doc.flush()).unwrap();
    expect((await a.row())?.title).toBe("New");
    (await racing).unwrap();
    expect((await a.row())?.title).toBe("New");
    // the snapshot still committed: the first entry is covered, the flush's own entry is tail
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["covered", "tail"]);
    (await doc.close()).unwrap();
    expect(a.errors).toEqual([]);
  });

  test("a joiner installing a checkpoint derives from the snapshot and the tail it holds above it", async () => {
    const a = await storedNode(8);
    const b = await storedNode(9);
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "First", "one");
    (await doc.flush()).unwrap();
    const at = hlcOf(a.now().epochMilliseconds, 0);
    const made = (await a.documents.checkpoint(DOC, a.identity, at)).unwrap();
    const title = doc.value.getText("title");
    title.delete(0, title.length);
    title.insert(0, "Second");
    doc.value.commit();
    (await doc.close()).unwrap();
    const link = createLink(a.engine, b.engine);
    (await link.catchUp()).unwrap();
    expect(await until(async () => (await b.engine.docLog()).unwrap().length === 2)).toBe(true);
    (await b.documents.install(made.signed.wire, a.identity.peerId, made.snapshot, DOC)).unwrap();
    // the edit above the checkpoint's floor stays tail, and the values already include it
    expect(await b.row()).toEqual({ title: "Second", words: 1 });
    expect((await b.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["covered", "tail"]);
    expect(b.errors).toEqual([]);
    link.close();
  });

  test("a materialisation whose derived write fails commits no snapshot either", async () => {
    const a = await storedNode(4);
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Draft", "a b");
    (await doc.flush()).unwrap();
    // the app's table loses the column the title lands in: the derived write cannot succeed
    await a.driver.run(`ALTER TABLE notes RENAME COLUMN title TO renamed`);
    const failed = await a.documents.materialise(DOC);
    expect(failed.isErr() && failed.error._tag).toBe("StoreFailure");
    const [head] = (await a.engine.docHeads()).unwrap();
    expect(head?.version).toBeUndefined();
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["tail"]);
  });

  test("changing a derive function needs no migration: the runtime recomputes as it starts", async () => {
    const driver = bunSqliteDriver(":memory:");
    const a = await storedNode(5, { driver });
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Budget", "x");
    (await doc.close()).unwrap();
    expect((await a.row())?.title).toBe("Budget");

    const shouted = schemaWith((d) => plainTitle(d).toUpperCase());
    // the derive is not in the table's shape: the state file's name, and its rows, stay put
    expect(schemaName(syncedTables(shouted))).toBe(schemaName(syncedTables(schema)));
    a.documents.stop();
    const later = createDocuments({
      engine: a.engine,
      adapters: [loro()],
      docs: DOCS,
      procedure: EDIT,
      autoMaterialise: false,
      derive: createDerivers(shouted),
    });
    // the runtime recomputes every row once as it starts: nobody has to edit the note (U25)
    expect(await until(async () => (await a.row())?.title === "BUDGET")).toBe(true);
    (await later.materialise(DOC)).unwrap();
    expect((await a.row())?.title).toBe("BUDGET");
    later.stop();
  });

  test("a derive function that throws is reported, and the edit is published anyway", async () => {
    const broken = schemaWith(() => {
      throw new Error("the app's bug");
    });
    const a = await storedNode(6, { schema: broken });
    await insertNote(a);
    // the insert's own recomputation finds an empty document: nothing to run the function on
    await a.documents.rederive(DOC);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "t", "still saved");
    expect((await doc.flush()).isOk()).toBe(true);
    expect((await a.engine.docLog()).unwrap().length).toBe(1);
    expect(a.errors.map((e) => e._tag)).toEqual(["DeriveFailed"]);
    expect(await a.row()).toEqual({ title: null, words: null });
    // a checkpoint takes the values its materialisation computed: one run, one report
    a.errors.length = 0;
    const at = hlcOf(a.now().epochMilliseconds, 0);
    const made = (await a.documents.checkpoint(DOC, a.identity, at)).unwrap();
    expect(made.signed.checkpoint.derived.size).toBe(0);
    expect(a.errors.map((e) => e._tag)).toEqual(["DeriveFailed"]);
  });
});

describe("derived columns catch up with the document between flushes (gaps U25)", () => {
  /** A device that edits the note and a peer it is linked to, both holding the note. */
  const linked = async (n: number) => {
    const a = await storedNode(n);
    const b = await storedNode(n + 1);
    await insertNote(a);
    const link = createLink(a.engine, b.engine);
    (await link.catchUp()).unwrap();
    return { a, b, link };
  };
  const retitle = (doc: LoroDoc, next: string) => {
    const title = doc.getText("title");
    title.delete(0, title.length);
    title.insert(0, next);
    doc.commit();
  };

  test("a remote edit to a document open here recomputes the row from the open replica", async () => {
    const { a, b, link } = await linked(20);
    const mine = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(mine.value, "Agenda", "one");
    (await mine.flush()).unwrap();
    await link.flush();
    const theirs = (await b.documents.open<LoroDoc>(DOC)).unwrap();
    expect(await until(async () => (await b.row())?.title === "Agenda")).toBe(true);
    // b only reads: nothing of its own is flushed, and its row still follows a's edits
    retitle(mine.value, "Agenda, revised");
    (await mine.flush()).unwrap();
    await link.flush();
    expect(await until(() => theirs.value.getText("title").toString() === "Agenda, revised")).toBe(
      true,
    );
    expect(await until(async () => (await b.row())?.title === "Agenda, revised")).toBe(true);
    expect((await b.engine.docLog()).unwrap()).toHaveLength(2);
    expect(b.errors).toEqual([]);
    (await theirs.close()).unwrap();
    (await mine.close()).unwrap();
    link.close();
  });

  /** A device that wrote the note and edited it, in two events, and its entries in log order. */
  const written = async (n: number, title: string, body: string) => {
    const a = await storedNode(n);
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, title, body);
    (await doc.close()).unwrap();
    const [insert, edit] = (await a.engine.eventsSince(new Map())).unwrap();
    if (insert === undefined || edit === undefined) throw new Error("two events were written");
    return { a, insert, edit };
  };

  test("a row whose insert lands after its document is derived when the insert arrives", async () => {
    const { insert, edit } = await written(22, "Early", "words before the row");
    const b = await storedNode(23);
    // delivered out of order: b folds the edit with no row to show it on
    (await b.engine.receive(edit)).unwrap();
    expect((await b.engine.docLog()).unwrap()).toHaveLength(1);
    await b.documents.rederive(DOC);
    expect(await b.row()).toBeUndefined();
    (await b.engine.receive(insert)).unwrap();
    expect(await until(async () => (await b.row())?.title === "Early")).toBe(true);
    expect(await b.row()).toEqual({ title: "Early", words: 4 });
    expect(b.errors).toEqual([]);
  });

  test("a row deleted and inserted again gets its derived values back", async () => {
    const { a, b, link } = await linked(24);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Kept", "x");
    (await doc.close()).unwrap();
    await link.flush();
    expect(await until(async () => (await b.row())?.title === "Kept")).toBe(true);
    (await a.engine.mutate(EDIT, (tx) => tx.delete(NOTES, N1), { partition: W1 })).unwrap();
    await link.flush();
    expect(await until(async () => (await b.row()) === undefined)).toBe(true);
    await insertNote(a);
    await link.flush();
    // the projection inserted the row afresh, without the title it never writes
    expect(await until(async () => (await b.row())?.title === "Kept")).toBe(true);
    expect(await until(async () => (await a.row())?.title === "Kept")).toBe(true);
    link.close();
  });

  test("a snapshot that brings a row whose document is already here derives it", async () => {
    const { a, edit } = await written(26, "From state", "a b");
    const b = await storedNode(27);
    (await b.engine.receive(edit)).unwrap();
    // the row comes as state rather than as the insert event (RFC-0019)
    (await b.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect(await until(async () => (await b.row())?.title === "From state")).toBe(true);
    expect(await b.row()).toEqual({ title: "From state", words: 2 });
    expect(b.errors).toEqual([]);
  });

  test("a purge that rebuilds the row derives it again from the document it keeps", async () => {
    const { a, b, link } = await linked(30);
    const c = await storedNode(32);
    const toC = createLink(a.engine, c.engine);
    (await toC.catchUp()).unwrap();
    const mine = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(mine.value, "Kept", "x y");
    (await mine.close()).unwrap();
    await toC.flush();
    const theirs = (await c.documents.open<LoroDoc>(DOC)).unwrap();
    theirs.value.getText("body").insert(0, "from c ");
    theirs.value.commit();
    (await theirs.close()).unwrap();
    await toC.flush();
    // live forwarding carries a device's own writes: c's edit reaches b through a's log
    (await link.catchUp()).unwrap();
    expect(await until(async () => (await b.row())?.words === 4)).toBe(true);
    expect(await b.row()).toEqual({ title: "Kept", words: 4 });
    // c's edit leaves b's log, and the row is dropped and rebuilt without the values it never writes
    const purged = (
      await b.engine.purge({ events: (event) => event.peerId === c.identity.peerId })
    ).unwrap();
    expect(purged.events).toBe(1);
    expect(await until(async () => (await b.row())?.words === 2)).toBe(true);
    expect(await b.row()).toEqual({ title: "Kept", words: 2 });
    expect(b.errors).toEqual([]);
    toC.close();
    link.close();
  });

  test("a purge invalidates an open replica, so the row is derived from the kept document, not it", async () => {
    const { a, b, link } = await linked(36);
    const c = await storedNode(38);
    const toC = createLink(a.engine, c.engine);
    (await toC.catchUp()).unwrap();
    const mine = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(mine.value, "Kept", "x y");
    (await mine.close()).unwrap();
    await toC.flush();
    const theirs = (await c.documents.open<LoroDoc>(DOC)).unwrap();
    theirs.value.getText("body").insert(0, "from c ");
    theirs.value.commit();
    (await theirs.close()).unwrap();
    await toC.flush();
    (await link.catchUp()).unwrap();
    expect(await until(async () => (await b.row())?.words === 4)).toBe(true);
    // b holds the document open across the purge: its replica still has c's edit in it
    const held = (await b.documents.open<LoroDoc>(DOC)).unwrap();
    expect(held.value.getText("body").toString()).toBe("from c x y");
    (await b.engine.purge({ events: (event) => event.peerId === c.identity.peerId })).unwrap();
    expect(held.status()).toBe("invalidated");
    await b.documents.rederive();
    expect(await b.row()).toEqual({ title: "Kept", words: 2 });
    // reopening loads the kept log, without c's edit
    const reopened = (await b.documents.open<LoroDoc>(DOC)).unwrap();
    expect(reopened.value.getText("body").toString()).toBe("x y");
    (await reopened.close()).unwrap();
    expect(b.errors).toEqual([]);
    toC.close();
    link.close();
  });

  test("a refused flush's values do not stand in for the row's when the next write lands", async () => {
    let refuse = false;
    const open = createValidator({ schema, grantFor: null, docs: DOCS });
    const toggled: Validator = {
      validate: (event, before) =>
        refuse
          ? Result.err(
              new PolicyDenied({ table: "notes", key: "n1", op: "update", message: "refused" }),
            )
          : open.validate(event, before),
    };
    const a = await storedNode(34, { validate: toggled });
    await insertNote(a);
    const draft = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(draft.value, "Draft", "x");
    refuse = true;
    expect((await draft.flush()).isErr()).toBe(true);
    refuse = false;
    await draft.close();
    // the next doc change is the app's own write, with no flush behind it
    const elsewhere = new LoroDoc();
    type(elsewhere, "Final", "a b c");
    (
      await a.engine.mutate(
        EDIT,
        (tx) =>
          tx.doc(NOTES, N1, {
            column: CONTENT,
            adapter: LORO_ID,
            update: { bytes: elsewhere.export({ mode: "snapshot" }) },
          }),
        { partition: W1 },
      )
    ).unwrap();
    expect(await until(async () => (await a.row())?.title === "Final")).toBe(true);
    expect(await a.row()).toEqual({ title: "Final", words: 3 });
  });

  test("a state rebuilt from the log gets its derived values back when the runtime starts", async () => {
    const driver = bunSqliteDriver(":memory:");
    const a = await storedNode(28, { driver });
    await insertNote(a);
    const doc = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Rebuilt", "one two");
    (await doc.close()).unwrap();
    expect(await a.row()).toEqual({ title: "Rebuilt", words: 2 });
    a.documents.stop();
    // a state file thrown away: the next open refolds the rows from the log, without their titles
    (await a.stores.state.clear()).unwrap();
    const reopened = (
      await openEngine({
        peerId: a.identity.peerId,
        clock: createHlcClock({ now: a.now }),
        store: a.stores.events,
        stateStore: a.stores.state,
        docStore: a.stores.docs,
        atomic: a.stores.atomic,
        validate: createValidator({ schema, grantFor: null, docs: DOCS }),
        docs: DOCS,
        docAdapters: new Set([LORO_ID]),
      })
    ).unwrap();
    expect(await a.row()).toEqual({ title: null, words: null });
    const documents = createDocuments({
      engine: reopened,
      adapters: [loro()],
      docs: DOCS,
      procedure: EDIT,
      autoMaterialise: false,
      derive: createDerivers(schema),
    });
    expect(await until(async () => (await a.row())?.title === "Rebuilt")).toBe(true);
    expect(await a.row()).toEqual({ title: "Rebuilt", words: 2 });
    // and an app that rewrote rows outside syncmesh asks for the same itself
    await driver.run(`UPDATE notes SET title = 'clobbered'`);
    await documents.rederive(DOC);
    expect((await a.row())?.title).toBe("Rebuilt");
    documents.stop();
  });
});

describe("an opaque host takes derived values from a device checkpoint (RFC-0023 §7.2)", () => {
  /** A device that edited the note, and a host without the adapter that folded the same events. */
  const pair = async (n: number, sealed = false, validate?: Validator) => {
    const using = sealed ? schemaWith(plainTitle, true) : schema;
    const device = await storedNode(n, { schema: using });
    const host = await storedNode(n + 50, {
      adapter: false,
      schema: using,
      ...(validate !== undefined && { validate }),
    });
    await insertNote(device);
    const link = createLink(device.engine, host.engine);
    (await link.catchUp()).unwrap();
    const doc = (await device.documents.open<LoroDoc>(DOC)).unwrap();
    type(doc.value, "Board pack", "five words in this body");
    (await doc.close()).unwrap();
    await link.flush();
    expect(await until(async () => (await host.engine.docLog()).unwrap().length === 1)).toBe(true);
    // forget the flush's values, so what the device's row holds next is the checkpoint's own work
    await device.driver.run(`UPDATE notes SET title = NULL, "wordCount" = NULL`);
    const at = hlcOf(device.now().epochMilliseconds, 0);
    const made = (await device.documents.checkpoint(DOC, device.identity, at)).unwrap();
    return { device, host, link, made };
  };

  test("the host writes key 8's values to its row, provisionally, and keeps the long log", async () => {
    const { device, host, link, made } = await pair(10);
    expect(made.signed.checkpoint.derived).toEqual(
      new Map<ColumnName, CellValue>([
        [TITLE, "Board pack"],
        [WORDS, 5],
      ]),
    );
    expect(await host.row()).toEqual({ title: null, words: null });
    const installed = await host.documents.installProvisional(
      made.signed.wire,
      device.identity.peerId,
      made.snapshot,
      DOC,
    );
    expect(installed.isOk()).toBe(true);
    expect(await host.row()).toEqual({ title: "Board pack", words: 5 });
    const [head] = (await host.engine.docHeads()).unwrap();
    expect(head?.mode).toBe("checkpoint");
    // a provisional snapshot makes nothing compactable: the host's log entries do not move
    expect((await host.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["adapter-missing"]);
    link.close();
  });

  test("the host refuses values outside the derive list, of the wrong kind, or past what it holds", async () => {
    const { device, host, link, made } = await pair(11);
    const { checkpoint } = made.signed;
    const install = (values: Row, covers = checkpoint.covers) =>
      host.documents.installProvisional(
        signCheckpoint({ ...checkpoint, derived: values, covers }, device.identity).wire,
        device.identity.peerId,
        made.snapshot,
        DOC,
      );
    const stray = await install(new Map<ColumnName, CellValue>([[ID, "n2"]]));
    expect(stray.isErr() && stray.error.message).toContain("not derived from content");
    const wrongKind = await install(new Map<ColumnName, CellValue>([[WORDS, "many"]]));
    expect(wrongKind.isErr() && wrongKind.error._tag).toBe("CheckpointRefused");
    const ahead = await install(
      checkpoint.derived,
      new Map(
        [...checkpoint.covers].map(([author, seq]) => [author, parseSeqNum(seq + 5).unwrap()]),
      ),
    );
    expect(ahead.isErr() && ahead.error.message).toContain("has not folded");
    expect(await host.row()).toEqual({ title: null, words: null });
    link.close();
  });

  test("the host takes key 8 only from a producer that may update the row (U26)", async () => {
    const reader = createIdentity(seed(99)).unwrap();
    const open = createValidator({ schema, grantFor: null, docs: DOCS });
    // the reader holds the partition and can sign a checkpoint of it; its grant edits nothing
    const readOnly: Validator = {
      validate: (event, before) =>
        event.peerId === reader.peerId
          ? Result.err(
              new PolicyDenied({ table: "notes", key: "n1", op: "update", message: "a reader" }),
            )
          : open.validate(event, before),
    };
    const { host, link, made } = await pair(13, false, readOnly);
    const forged = signCheckpoint(
      { ...made.signed.checkpoint, derived: new Map([[TITLE, "Pwned"]]) },
      reader,
    );
    const refused = await host.documents.installProvisional(
      forged.wire,
      reader.peerId,
      made.snapshot,
      DOC,
    );
    expect(refused.isErr() && refused.error.message).toBe("its producer may not update this row");
    expect(refused.isErr() && refused.error.cause).toBeInstanceOf(PolicyDenied);
    expect(await host.row()).toEqual({ title: null, words: null });
    expect((await host.engine.docHeads()).unwrap()[0]?.mode).not.toBe("checkpoint");
    link.close();
  });

  test("a sealed partition's checkpoint carries no derived values, and its columns stay unset on the host", async () => {
    const { device, host, link, made } = await pair(12, true);
    expect(made.signed.checkpoint.derived.size).toBe(0);
    // the device itself, holding the partition's key, computed its own title
    expect(await device.row()).toEqual({ title: "Board pack", words: 5 });
    (
      await host.documents.installProvisional(
        made.signed.wire,
        device.identity.peerId,
        made.snapshot,
        DOC,
      )
    ).unwrap();
    expect(await host.row()).toEqual({ title: null, words: null });
    const leaking = signCheckpoint(
      { ...made.signed.checkpoint, derived: new Map([[TITLE, "Board pack"]]) },
      device.identity,
    );
    const refused = await host.documents.installProvisional(
      leaking.wire,
      device.identity.peerId,
      made.snapshot,
      DOC,
    );
    expect(refused.isErr() && refused.error.message).toContain("sealed");
    link.close();
  });
});
