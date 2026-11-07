import { AdapterMissing, DocPending, HandleInvalidated, UpdateTooLarge } from "@syncmesh/docs";
import { DocCoverStale } from "@syncmesh/engine";
import { eventId, hlcOf, parseAdapterId, parseLineageId, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { signCheckpoint } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { LoroDoc } from "loro-crdt";

import { LORO_ID } from "../index.js";
import {
  CONTENT,
  DOC,
  EDIT,
  N1,
  N2,
  NOTES,
  W1,
  body,
  heldTail,
  insertNote,
  linked,
  node,
  type,
  until,
} from "./fixtures.js";

describe("loro@1 through the engine: open, flush, fold, converge", () => {
  test("two devices editing one document concurrently converge on one text and one version", async () => {
    const a = node(10);
    const b = node(20);
    await insertNote(a);
    const link = await linked(a, b);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    const db = (await b.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "Hello");
    type(db.value, 0, "World");
    (await da.flush()).unwrap();
    (await db.flush()).unwrap();
    await link.flush();
    expect(
      await until(() => body(da.value) === body(db.value) && body(da.value).length === 10),
    ).toBe(true);
    expect(da.value.oplogVersion().compare(db.value.oplogVersion())).toBe(0);
    // one doc change per flush, each its own event in the log
    expect((await a.engine.docLog()).unwrap().length).toBe(2);
    link.close();
  });

  test("edits made apart merge when the link returns, and nothing typed is lost", async () => {
    const a = node(11);
    const b = node(21);
    await insertNote(a);
    const link = await linked(a, b);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    const db = (await b.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "shared ");
    (await da.flush()).unwrap();
    await link.flush();
    expect(await until(() => body(db.value) === "shared ")).toBe(true);

    link.setOnline(false);
    type(da.value, 7, "from a");
    (await da.flush()).unwrap();
    type(db.value, 0, "b says: ");
    (await db.flush()).unwrap();
    type(db.value, body(db.value).length, "!");
    (await db.flush()).unwrap();
    expect(body(da.value)).toBe("shared from a");
    expect(body(db.value)).toBe("b says: shared !");

    link.setOnline(true);
    (await link.catchUp()).unwrap();
    expect(await until(() => body(da.value) === body(db.value))).toBe(true);
    for (const piece of ["shared", "from a", "b says: ", "!"])
      expect(body(da.value)).toContain(piece);
    link.close();
  });

  test("a burst of commits is paced into one event; a closed document reopens from the log", async () => {
    const a = node(12);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    for (const ch of "typing") type(da.value, body(da.value).length, ch);
    expect(await until(async () => (await a.engine.docLog()).unwrap().length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await a.engine.docLog()).unwrap().length).toBe(1);
    (await da.close()).unwrap();
    const again = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    expect(body(again.value)).toBe("typing");
    // two opens share one replica
    const twin = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    expect(twin.value).toBe(again.value);
  });
});

describe("loro@1 handles: opens that race a read of the log", () => {
  test("two opens issued together share one replica, and both see what the other types", async () => {
    const a = node(50);
    await insertNote(a);
    const [x, y] = await Promise.all([
      a.documents.open<LoroDoc>(DOC),
      a.documents.open<LoroDoc>(DOC),
    ]);
    expect(x.unwrap().value).toBe(y.unwrap().value);
    type(x.unwrap().value, 0, "once");
    (await y.unwrap().flush()).unwrap();
    expect((await a.engine.docLog()).unwrap().length).toBe(1);
  });

  test("a remote update that folds while the tail is being read reaches the opened document", async () => {
    const a = node(51);
    const b = node(52);
    await insertNote(a);
    const link = await linked(a, b);
    const slow = heldTail(b);
    const opening = slow.documents.open<LoroDoc>(DOC);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "typed while b was opening");
    (await da.flush()).unwrap();
    await link.flush();
    expect(await until(async () => (await b.engine.docLog()).unwrap().length === 1)).toBe(true);
    slow.release();
    const db = (await opening).unwrap();
    expect(body(db.value)).toBe("typed while b was opening");
    slow.documents.stop();
    link.close();
  });
});

describe("loro@1 history: materialise, compact, then a late joiner", () => {
  test("past the history bound the tail is materialised, compaction takes its events, and a joiner installs the checkpoint", async () => {
    const a = node(13, { limits: { snapshotEvery: 3 } });
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    for (const word of ["one ", "two ", "three ", "four "]) {
      type(da.value, body(da.value).length, word);
      (await da.flush()).unwrap();
    }
    // the bound fired in the background: three updates covered, the fourth still the tail
    expect(
      await until(async () =>
        (await a.engine.docLog()).unwrap().some((e) => e.state === "covered"),
      ),
    ).toBe(true);
    (await a.documents.materialise(DOC)).unwrap();
    const states = (await a.engine.docLog()).unwrap().map((e) => e.state);
    expect(states).toEqual(["covered", "covered", "covered", "covered"]);

    // the relay this device syncs through has acknowledged everything it wrote
    const relay = node(43);
    const toRelay = await linked(a, relay);
    a.engine.acknowledge(
      relay.engine.peerId,
      relay.engine.coverage().synced,
      Temporal.Now.instant(),
    );
    toRelay.close();
    const before = (await a.store.all()).unwrap().length;
    (await a.engine.compact({ now: Temporal.Now.instant() })).unwrap();
    const after = (await a.store.all()).unwrap().length;
    expect(after).toBeLessThan(before);

    // a reopen after compaction reads the snapshot: the events behind it are gone
    (await da.close()).unwrap();
    const reread = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    expect(body(reread.value)).toBe("one two three four ");

    // the late joiner: the row from a snapshot, the document from a signed checkpoint
    const c = node(30);
    await c.engine.installSnapshot(a.engine.snapshot());
    const made = (await a.documents.checkpoint(DOC, a.identity, hlcOf(Date.now(), 0))).unwrap();
    (await c.documents.install(made.signed.wire, a.identity.peerId, made.snapshot, DOC)).unwrap();
    const link = await linked(a, c);
    type(reread.value, 0, "> ");
    (await reread.flush()).unwrap();
    await link.flush();
    const dc = (await c.documents.open<LoroDoc>(DOC)).unwrap();
    expect(await until(() => body(dc.value) === "> one two three four ")).toBe(true);
    link.close();
  });

  test("a checkpoint is refused when forged, tampered, or of a snapshot that does not reproduce its version", async () => {
    const a = node(14);
    const mallory = node(99);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "the real text");
    (await da.flush()).unwrap();
    const made = (await a.documents.checkpoint(DOC, a.identity, hlcOf(Date.now(), 0))).unwrap();
    const c = node(31);
    await c.engine.installSnapshot(a.engine.snapshot());

    const wrongKey = await c.documents.install(
      made.signed.wire,
      mallory.identity.peerId,
      made.snapshot,
      DOC,
    );
    expect(wrongKey.isErr() && wrongKey.error._tag).toBe("CheckpointRefused");

    const tampered = Uint8Array.from(made.snapshot);
    tampered.set([(tampered.at(-1) ?? 0) ^ 0xff], tampered.length - 1);
    const badBytes = await c.documents.install(made.signed.wire, a.identity.peerId, tampered, DOC);
    expect(badBytes.isErr() && badBytes.error.message).toContain("not the ones");

    // a validly signed checkpoint whose snapshot is not at the version it claims
    const { checkpoint } = made.signed;
    const claimed = Uint8Array.from(checkpoint.version);
    claimed[claimed.length - 1] = (claimed.at(-1) ?? 0) + 1;
    const lying = signCheckpoint({ ...checkpoint, version: claimed }, a.identity);
    const mismatch = await c.documents.install(lying.wire, a.identity.peerId, made.snapshot, DOC);
    expect(mismatch.isErr() && mismatch.error.message).toContain("does not reproduce");

    const elsewhere = await c.documents.install(
      made.signed.wire,
      a.identity.peerId,
      made.snapshot,
      {
        ...DOC,
        key: N2,
      },
    );
    expect(elsewhere.isErr() && elsewhere.error.message).toContain("another document");

    const honest = await c.documents.install(
      made.signed.wire,
      a.identity.peerId,
      made.snapshot,
      DOC,
    );
    expect(honest.isOk()).toBe(true);
    expect(body((await c.documents.open<LoroDoc>(DOC)).unwrap().value)).toBe("the real text");
  });
});

describe("loro@1 checkpoints never move a snapshot back", () => {
  test("a checkpoint older than the snapshot this device holds is refused, and nothing typed is lost", async () => {
    const a = node(53);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "one ");
    (await da.flush()).unwrap();
    const old = (await a.documents.checkpoint(DOC, a.identity, hlcOf(Date.now(), 0))).unwrap();
    type(da.value, 4, "two");
    (await da.flush()).unwrap();
    (await a.documents.materialise(DOC)).unwrap();

    const stale = await a.documents.install(old.signed.wire, a.identity.peerId, old.snapshot, DOC);
    expect(stale.isErr() && stale.error.message).toContain("behind the snapshot");
    (await da.close()).unwrap();
    expect(body((await a.documents.open<LoroDoc>(DOC)).unwrap().value)).toBe("one two");
  });

  test("a signed checkpoint whose floor claims updates its snapshot lacks is refused", async () => {
    const a = node(66);
    const c = node(67);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "one ");
    (await da.flush()).unwrap();
    const made = (await a.documents.checkpoint(DOC, a.identity, hlcOf(Date.now(), 0))).unwrap();
    type(da.value, 4, "two");
    (await da.flush()).unwrap();
    const link = await linked(a, c);
    const last = Math.max(...(await c.engine.docLog()).unwrap().map((e) => e.seq));
    const { checkpoint } = made.signed;
    const inflated = signCheckpoint(
      { ...checkpoint, covers: new Map([[a.engine.peerId, parseSeqNum(last).unwrap()]]) },
      a.identity,
    );
    const refused = await c.documents.install(inflated.wire, a.identity.peerId, made.snapshot, DOC);
    expect(refused.isErr() && refused.error.message).toContain("lacks updates");
    expect((await c.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["tail", "tail"]);
    expect(body((await c.documents.open<LoroDoc>(DOC)).unwrap().value)).toBe("one two");
    link.close();
  });
});

describe("loro@1 refusals and bounds", () => {
  test("a doc change naming another adapter for a loro@1 column is refused at the fold, on every peer", async () => {
    const a = node(15);
    const b = node(25);
    await insertNote(a);
    const link = await linked(a, b);
    const automerge = parseAdapterId("automerge@3").unwrap();
    const forged = await a.engine.mutate(
      EDIT,
      (tx) =>
        tx.doc(NOTES, N1, {
          column: CONTENT,
          adapter: automerge,
          update: { bytes: Uint8Array.of(1) },
        }),
      { partition: W1 },
    );
    expect(forged.isErr()).toBe(true);
    expect((await b.engine.docLog()).unwrap()).toEqual([]);
    link.close();
  });

  test("a genesis naming a lineage its place does not derive is quarantined by the receiver", async () => {
    const a = node(16);
    const b = node(26);
    await insertNote(a);
    const link = await linked(a, b);
    const quarantined: string[] = [];
    b.engine.onQuarantine((q) => quarantined.push(q.reason._tag));
    const event = (
      await a.engine.mutate(
        EDIT,
        (tx) =>
          tx.doc(NOTES, N1, {
            column: CONTENT,
            adapter: parseAdapterId("loro@1").unwrap(),
            update: { bytes: Uint8Array.of(1) },
            genesis: true,
          }),
        { partition: W1 },
      )
    ).unwrap();
    await link.flush();
    const [change] = event.changes;
    if (change?.kind !== "doc") throw new Error("the event carries the genesis");
    const lie = { ...change, lineage: parseLineageId("00".repeat(16)).unwrap() };
    const seqNum = parseSeqNum(event.seqNum + 1).unwrap();
    const forged = { ...event, id: eventId(event.peerId, seqNum), seqNum, changes: [lie] };
    const report = (await b.engine.receiveBatch([{ event: forged }])).unwrap();
    expect(report.quarantined).toBe(1);
    expect(quarantined).toEqual(["DocChangeRefused"]);
    link.close();
  });

  test("a burst over the inline bound is refused as a value and invalidates the handle", async () => {
    const a = node(17, { limits: { maxUpdateBytes: 64 } });
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "x".repeat(500));
    const flushed = await da.flush();
    expect(flushed.isErr() && flushed.error).toBeInstanceOf(UpdateTooLarge);
    expect(da.status()).toBe("invalidated");
    const again = await da.flush();
    expect(again.isErr() && again.error).toBeInstanceOf(HandleInvalidated);
    expect((await a.engine.docLog()).unwrap()).toEqual([]);
  });

  test("bytes the adapter cannot read fold like any update, and materialise marks them failed", async () => {
    const a = node(18);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "good");
    (await da.flush()).unwrap();
    (
      await a.engine.mutate(
        EDIT,
        (tx) =>
          tx.doc(NOTES, N1, {
            column: CONTENT,
            adapter: parseAdapterId("loro@1").unwrap(),
            update: { bytes: Uint8Array.of(0xde, 0xad, 0xbe, 0xef) },
          }),
        { partition: W1 },
      )
    ).unwrap();
    const done = (await a.documents.materialise(DOC)).unwrap();
    expect([done.covered, done.failed]).toEqual([1, 1]);
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["covered", "failed"]);
    (await da.close()).unwrap();
    expect(body((await a.documents.open<LoroDoc>(DOC)).unwrap().value)).toBe("good");
  });

  test("a device without the adapter folds and forwards the column, and opening it says so", async () => {
    const a = node(19);
    const relay = node(29, { adapter: false });
    const c = node(39);
    await insertNote(a);
    const ar = await linked(a, relay);
    const rc = await linked(relay, c);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "carried by a device that cannot read it");
    (await da.flush()).unwrap();
    await ar.flush();
    // an in-process link pushes what a device authors; what it only carries goes on catch-up
    (await rc.catchUp()).unwrap();
    expect(await until(async () => (await c.engine.docLog()).unwrap().length === 1)).toBe(true);
    expect((await relay.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["adapter-missing"]);
    const opened = await relay.documents.open<LoroDoc>(DOC);
    expect(opened.isErr() && opened.error).toBeInstanceOf(AdapterMissing);
    const dc = (await c.documents.open<LoroDoc>(DOC)).unwrap();
    expect(body(dc.value)).toBe("carried by a device that cannot read it");
    ar.close();
    rc.close();
  });
});

/** A Loro document holding `text`, written by `replica` and apart from any handle. */
const authored = (replica: bigint, text: string) => {
  const doc = new LoroDoc();
  doc.setPeerId(replica);
  type(doc, 0, text);
  return doc;
};

describe("loro@1 materialisations never cover what their snapshot lacks", () => {
  test("of two materialisations that overlap, the one built on an older head is refused", async () => {
    const a = node(64);
    await insertNote(a);
    const da = (await a.documents.open<LoroDoc>(DOC)).unwrap();
    type(da.value, 0, "one ");
    (await da.flush()).unwrap();
    const slow = heldTail(a);
    const first = slow.documents.materialise(DOC); // has read a tail of "one " only
    type(da.value, 4, "two");
    (await da.flush()).unwrap();
    (await a.documents.materialise(DOC)).unwrap();
    slow.release();
    const stale = await first;
    expect(stale.isErr() && stale.error).toBeInstanceOf(DocCoverStale);
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["covered", "covered"]);
    await da.close();
    expect(body((await a.documents.open<LoroDoc>(DOC)).unwrap().value)).toBe("one two");
    slow.documents.stop();
  });

  test("an update waiting on a blob not yet held keeps the document from materialising", async () => {
    const a = node(65);
    await insertNote(a);
    const x = authored(1n, "first ");
    const u1 = x.export({ mode: "update" });
    const y = new LoroDoc();
    y.setPeerId(2n);
    y.import(u1);
    type(y, 6, "second");
    const u2 = y.export({ mode: "update", from: x.oplogVersion() });
    // u1 travels as a blob this device has not fetched, u2 inline: Loro holds u2 pending
    for (const update of [{ blob: { hash: "ab".repeat(32), size: u1.length } }, { bytes: u2 }])
      (
        await a.engine.mutate(
          EDIT,
          (tx) => tx.doc(NOTES, N1, { column: CONTENT, adapter: LORO_ID, update }),
          { partition: W1 },
        )
      ).unwrap();
    const pending = await a.documents.materialise(DOC);
    expect(pending.isErr() && pending.error).toBeInstanceOf(DocPending);
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual([
      "bytes-missing",
      "tail",
    ]);
    expect((await a.documents.open<LoroDoc>(DOC)).unwrap().status()).toBe("behind");
  });
});
