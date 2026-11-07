import type { ColumnName, RowKey, TableName } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { RowPatch } from "../frames.js";

import { decodeWindowFrame, rowsFrame } from "../frames.js";
import { createPatchStream } from "../stream.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const MAIL = "mail" as TableName;
const SUBJECT = "subject" as ColumnName;
const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const put = (k: string, subject: string) => ({
  table: MAIL,
  key: key(k),
  row: new Map([[SUBJECT, subject]]),
});

const patch = (over: Partial<RowPatch> & Pick<RowPatch, "epoch" | "version">): RowPatch => ({
  reset: false,
  puts: [],
  dels: [],
  windows: [],
  refused: [],
  ...over,
});

const opening = patch({
  epoch: "e1",
  version: 1,
  reset: true,
  puts: [put("a", "hello"), put("b", "invoice")],
  windows: [{ id: "inbox", table: MAIL, keys: [key("b"), key("a")] }],
});

const subjects = (stream: ReturnType<typeof createPatchStream>, id: string) =>
  stream.rows(id).map((r) => r.row.get(SUBJECT));

describe("versioned row patches (E24)", () => {
  test("a rows frame survives the wire with its epoch, version and reset flag", () => {
    const decoded = decodeWindowFrame(rowsFrame(opening)).unwrap();
    expect(decoded).toEqual({ kind: "rows", ...opening });
  });

  test("a reset opens the stream and the window renders in the server's order", () => {
    const stream = createPatchStream();
    expect(stream.apply(opening)).toBe("applied");
    expect(subjects(stream, "inbox")).toEqual(["invoice", "hello"]);
    expect(stream.position()).toEqual({ epoch: "e1", version: 1 });
  });

  test("the next version applies: a changed row, a deleted row, a new key list", () => {
    const stream = createPatchStream();
    stream.apply(opening);
    const next = patch({
      epoch: "e1",
      version: 2,
      puts: [put("a", "hello again")],
      dels: [{ table: MAIL, key: key("b") }],
      windows: [{ id: "inbox", table: MAIL, keys: [key("a")] }],
    });
    expect(stream.apply(next)).toBe("applied");
    expect(subjects(stream, "inbox")).toEqual(["hello again"]);
    expect(stream.held()).toBe(1);
  });

  test("a skipped version is a gap and changes nothing", () => {
    const stream = createPatchStream();
    stream.apply(opening);
    const skipped = patch({ epoch: "e1", version: 3, dels: [{ table: MAIL, key: key("a") }] });
    expect(stream.apply(skipped)).toBe("gap");
    expect(subjects(stream, "inbox")).toEqual(["invoice", "hello"]);
    expect(stream.position()).toEqual({ epoch: "e1", version: 1 });
  });

  test("a patch from another epoch is a gap, and so is any patch before the first reset", () => {
    const stream = createPatchStream();
    expect(stream.apply(patch({ epoch: "e1", version: 1 }))).toBe("gap");
    stream.apply(opening);
    expect(stream.apply(patch({ epoch: "e2", version: 2 }))).toBe("gap");
  });

  test("a reset after a gap replaces everything held, whatever the epoch", () => {
    const stream = createPatchStream();
    stream.apply(opening);
    const resnapshot = patch({
      epoch: "e2",
      version: 1,
      reset: true,
      puts: [put("c", "contract")],
      windows: [{ id: "inbox", table: MAIL, keys: [key("c")] }],
    });
    expect(stream.apply(resnapshot)).toBe("applied");
    expect(subjects(stream, "inbox")).toEqual(["contract"]);
    expect(stream.held()).toBe(1);
  });

  test("a refused window is dropped and other frames on the socket are not window frames", () => {
    const stream = createPatchStream();
    stream.apply(opening);
    stream.apply(
      patch({ epoch: "e1", version: 2, refused: [{ id: "inbox", reason: "unknown table" }] }),
    );
    expect(stream.rows("inbox")).toEqual([]);
    expect(decodeWindowFrame(Uint8Array.of(0x81, 0x0b)).unwrap()).toBeUndefined();
  });

  test("a window's rows are the same array until a patch lands, so they can be a snapshot", () => {
    const stream = createPatchStream();
    stream.apply(opening);
    const first = stream.rows("inbox");
    expect(stream.rows("inbox")).toBe(first);
    expect(stream.rows("unknown")).toBe(stream.rows("other"));
    stream.apply(patch({ epoch: "e1", version: 2, puts: [put("a", "hello again")] }));
    expect(stream.rows("inbox")).not.toBe(first);
    expect(subjects(stream, "inbox")).toEqual(["invoice", "hello again"]);
  });

  test("forgetting a window drops the rows no other window holds", () => {
    const stream = createPatchStream();
    stream.apply({
      ...opening,
      windows: [...opening.windows, { id: "starred", table: MAIL, keys: [key("a")] }],
    });
    stream.forget("inbox");
    expect(stream.held()).toBe(1);
    expect(subjects(stream, "starred")).toEqual(["hello"]);
    expect(stream.rows("inbox")).toEqual([]);
  });
});
