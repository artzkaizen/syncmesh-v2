import type { JsonValue } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import { t } from "../column.js";
import { syncSchema } from "../manifest.js";
import { user } from "../partition.js";
import { formatShippedSchema, parseShippedSchema, shippedSchema } from "../shipped.js";

const shipped = shippedSchema(
  syncSchema({
    schemaVersion: 2,
    dropped: ["memos"],
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), owner: t.text().nullable().retired() },
        partition: user,
      },
    },
  }),
);

describe("the shipped-schema file (D31)", () => {
  test("the committed file reads back to what was written, and anything else is a value", () => {
    expect(parseShippedSchema(formatShippedSchema(shipped)).unwrap()).toEqual(shipped);
    expect(parseShippedSchema("{").isErr()).toBe(true);
    expect(parseShippedSchema(JSON.stringify({ ...shipped, v: 2 })).isErr()).toBe(true);
    expect(parseShippedSchema(JSON.stringify({ ...shipped, schemaVersion: 0 })).isErr()).toBe(true);
    // a table's removed columns are names, or the file is not one
    const withDropped = (dropped: JsonValue) =>
      JSON.stringify({ ...shipped, tables: { notes: { ...shipped.tables["notes"], dropped } } });
    expect(parseShippedSchema(withDropped(["owner"])).isOk()).toBe(true);
    expect(parseShippedSchema(withDropped([1])).isErr()).toBe(true);
    expect(parseShippedSchema(withDropped("owner")).isErr()).toBe(true);
  });
});
