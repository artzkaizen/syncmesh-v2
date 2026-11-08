import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  createHlcClock,
  parseAdapterId,
  parsePeerId,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { AdapterMissing, NotADocColumn, createDocuments, replicaId } from "../index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const NOTES = "notes" as TableName;
const CONTENT = "content" as ColumnName;
const TITLE = "title" as ColumnName;
const N1 = "n1" as RowKey;
const EDIT = "notes.edit" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const PEER = parsePeerId("ab".repeat(32)).unwrap();

describe("replicaId", () => {
  test("is a pure function of the peer and the nonce, under 2^63", () => {
    const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(replicaId(PEER, nonce)).toBe(replicaId(PEER, nonce));
    expect(replicaId(PEER, nonce)).toBeLessThan(1n << 63n);
  });

  test("a fresh nonce is a fresh replica: two handles of one device never share one", () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 1000; i += 1)
      seen.add(replicaId(PEER, crypto.getRandomValues(new Uint8Array(16))));
    expect(seen.size).toBe(1000);
  });
});

describe("createDocuments.open", () => {
  const engine = createEngine({
    peerId: PEER,
    clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(1) }),
    store: createMemoryEventStore(),
  });
  const loro = parseAdapterId("loro@1").unwrap();
  const documents = createDocuments({
    engine,
    adapters: [],
    docs: new Map([[NOTES, new Map([[CONTENT, loro]])]]),
    procedure: EDIT,
  });

  test("a column the mesh does not declare as a document is not one", async () => {
    const opened = await documents.open({ table: NOTES, key: N1, column: TITLE });
    expect(opened.isErr() && opened.error).toBeInstanceOf(NotADocColumn);
  });

  test("a declared column whose adapter this device lacks says which adapter", async () => {
    const opened = await documents.open({ table: NOTES, key: N1, column: CONTENT });
    expect(opened.isErr() && opened.error).toBeInstanceOf(AdapterMissing);
    expect(opened.isErr() && opened.error instanceof AdapterMissing && opened.error.adapter).toBe(
      "loro@1",
    );
  });
});
