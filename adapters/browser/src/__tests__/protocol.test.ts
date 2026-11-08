import { RetiredWrite, TableDropped } from "@syncmesh/engine";
import { serializeTagged } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";

import { failures } from "../protocol.js";

describe("the failures that cross to a tab", () => {
  test("a write refused for D31's retired or dropped schema revives as its own class", () => {
    const retired = new RetiredWrite({ table: "notes", column: "owner", message: "retired" });
    const revived = failures.revive(serializeTagged(retired));
    expect(revived).toBeInstanceOf(RetiredWrite);
    expect(revived instanceof RetiredWrite && [revived.table, revived.column]).toEqual([
      "notes",
      "owner",
    ]);
    const dropped = new TableDropped({ table: "memos", message: "dropped" });
    expect(failures.revive(serializeTagged(dropped))).toBeInstanceOf(TableDropped);
  });
});
