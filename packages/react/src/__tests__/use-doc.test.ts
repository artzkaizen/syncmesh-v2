import "./dom.js";
import { createDocuments } from "@syncmesh/docs";
import { OPLOG_ID, append, oplog, values, type OpLog } from "@syncmesh/docs/testing";
import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  createHlcClock,
  parsePeerId,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";

import type { UseDoc } from "../use-doc.js";

import { useDoc } from "../use-doc.js";
import { mount } from "./mount.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const CONTENT = "content" as ColumnName;
const N1 = "n1" as RowKey;
const N2 = "n2" as RowKey;
const EDIT = "notes.edit" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const DOCS = new Map([[NOTES, new Map([[CONTENT, OPLOG_ID]])]]);

let devices = 0;
const runtime = (adapters = [oplog()]) => {
  devices += 1;
  const engine = createEngine({
    peerId: parsePeerId(devices.toString(16).padStart(2, "0").repeat(32)).unwrap(),
    clock: createHlcClock({ now: () => Temporal.Now.instant() }),
    store: createMemoryEventStore(),
    docs: DOCS,
    docAdapters: new Set([OPLOG_ID]),
  });
  return { engine, documents: createDocuments({ engine, adapters, docs: DOCS, procedure: EDIT }) };
};

describe("useDoc (RFC-0023 §4.3)", () => {
  test("opens on mount, re-renders on an update, and closes on unmount, flushing what was typed", async () => {
    const { engine, documents } = runtime();
    const ref = documents.ref<OpLog>({ table: NOTES, key: N1, column: CONTENT });
    const seen: UseDoc<OpLog, unknown>[] = [];
    const Note = () => {
      seen.push(useDoc(ref));
      return null;
    };
    const { root, settle } = await mount(createElement(Note));
    const opened = seen.at(-1);
    expect(opened?.status).toBe("current");
    if (opened?.status !== "current") throw new Error("the document opened");

    // another device types; the fold hands its update to the open replica, and the hook renders
    const remote = runtime();
    const theirs = (
      await remote.documents.open<OpLog>({ table: NOTES, key: N1, column: CONTENT })
    ).unwrap();
    append(theirs.value, "typed elsewhere");
    (await theirs.flush()).unwrap();
    const before = opened.revision;
    const sent = (await remote.engine.eventsSince(engine.coverage().synced)).unwrap();
    await act(async () => void (await engine.receiveBatch(sent)).unwrap());
    await settle();
    const after = seen.at(-1);
    expect(after?.revision).toBeGreaterThan(before);
    expect(values(opened.doc)).toEqual(["typed elsewhere"]);

    append(opened.doc, "typed here");
    await act(async () => root.unmount());
    await settle();
    const log = (await engine.docLog()).unwrap();
    // the remote update, and the flush the unmount's close made
    expect(log).toHaveLength(2);
    expect(seen.every((s) => s.status !== "failed")).toBe(true);
  });

  test("a column the runtime cannot open is failed, with the reason", async () => {
    const { documents } = runtime([]);
    const ref = documents.ref<OpLog>({ table: NOTES, key: N1, column: CONTENT });
    const seen: UseDoc<OpLog, { readonly _tag: string }>[] = [];
    const Note = () => {
      seen.push(useDoc(ref));
      return null;
    };
    await mount(createElement(Note));
    const last = seen.at(-1);
    expect(last?.status === "failed" && last.error._tag).toBe("AdapterMissing");
  });

  test("a new ref closes the old document and opens the new one", async () => {
    const { documents } = runtime();
    const one = documents.ref<OpLog>({ table: NOTES, key: N1, column: CONTENT });
    const two = documents.ref<OpLog>({ table: NOTES, key: N2, column: CONTENT });
    const docs: (OpLog | undefined)[] = [];
    const Note = ({ which }: { readonly which: typeof one }) => {
      docs.push(useDoc(which).doc);
      return null;
    };
    const { root, settle } = await mount(createElement(Note, { which: one }));
    const first = docs.at(-1);
    await act(async () => root.render(createElement(Note, { which: two })));
    await settle();
    const second = docs.at(-1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // the first replica's last handle closed, so a reopen loads a fresh one
    const reopened = (await one.open()).unwrap();
    expect(reopened.value).not.toBe(first);
    await act(async () => root.unmount());
  });
});
