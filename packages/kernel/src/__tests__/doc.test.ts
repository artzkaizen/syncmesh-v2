import { describe, expect, test } from "bun:test";

import type { DocChange, LineageId } from "../doc.js";

import { applyChange } from "../apply.js";
import { parseActionId, parseAdapterId, parseLineageId } from "../doc.js";
import { applyAll, column, insert, N1, NOTES, PEER_A, PEER_B, stamp } from "./fixtures.js";

const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const lineage = (fill: string): LineageId => parseLineageId(fill.repeat(32)).unwrap();

const doc = (extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: NOTES,
  key: N1,
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(1, 2, 3) },
  ...extra,
});

describe("doc ids", () => {
  test("a 16-byte id is 32 lowercase hex characters, and nothing else", () => {
    expect(parseLineageId("ab".repeat(16)).isOk()).toBe(true);
    expect(parseActionId("0".repeat(32)).isOk()).toBe(true);
    for (const bad of ["AB".repeat(16), "ab".repeat(15), "ab".repeat(17), "zz".repeat(16)])
      expect(parseLineageId(bad).isErr()).toBe(true);
  });

  test("an adapter id names its major", () => {
    for (const good of ["loro@1", "automerge@3", "y-js@12"])
      expect(parseAdapterId(good).isOk()).toBe(true);
    for (const bad of ["loro", "loro@0", "Loro@1", "loro@1.2", "@1", "loro@"])
      expect(parseAdapterId(bad).isErr()).toBe(true);
  });
});

describe("applyChange — a doc change", () => {
  test("moves no cell: the update is the doc log's, never a value", () => {
    const state = applyAll([insert({ title: "t" }, stamp(1, 0, PEER_A))]);
    for (const change of [doc(), doc({ lineage: lineage("a"), genesis: true })])
      expect(applyChange(state, change, stamp(2, 0, PEER_B))).toBe(state);
  });
});
