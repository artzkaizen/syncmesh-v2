import { from, partition, syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import { meshCells } from "../mapping.js";

/** A CDC-published table with a document column and a column derived from it (RFC-0023 §16.4). */
const schema = syncSchema({
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        orgId: t.text(),
        title: t.text(),
        content: t.blob({ merge: { id: "loro@1" } }).nullable(),
      },
      partition: partition("org"),
      derive: { title: from("content", (doc: string) => doc) },
      allow: ({ allow }) => ({ $default: allow }),
    },
  },
});

describe("meshCells", () => {
  test("leaves document and derived columns out of the change it builds (U28)", () => {
    const cells = meshCells(schema.tables.notes, {
      id: "n1",
      orgId: "acme",
      title: "the authority's own derive",
      content: Uint8Array.of(1, 2, 3),
    });
    // a document travels as doc changes and a derived column is every replica's own: neither is
    // a value a change may carry, so the validator's probe would refuse the event with it
    expect([...cells.keys()].map(String)).toEqual(["id", "orgId"]);
  });
});
