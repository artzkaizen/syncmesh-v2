import { openEngine } from "@syncmesh/engine";
import {
  createHlcClock,
  parsePeerId,
  readRow,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultStore } from "../index.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const PEER = parsePeerId("a".repeat(64)).unwrap();
const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });

describe("defaultStore", () => {
  test("write, stop, reopen the same dir, read — and the directory is created", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "syncmesh-default-")), "nested", "data");
    expect(existsSync(dir)).toBe(false);

    const first = (await defaultStore({ name: "notes", dir })).unwrap();
    const engine = (
      await openEngine({
        peerId: PEER,
        clock: clock(),
        store: first.events,
        stateStore: first.state,
      })
    ).unwrap();
    (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, new Map([[BODY, "hello"]])))
    ).unwrap();
    await first.close();
    expect(existsSync(join(dir, "notes.db"))).toBe(true);

    const second = (await defaultStore({ name: "notes", dir })).unwrap();
    const reopened = (
      await openEngine({
        peerId: PEER,
        clock: clock(),
        store: second.events,
        stateStore: second.state,
      })
    ).unwrap();
    expect(readRow(reopened.state(), NOTES, N1)?.get(BODY)).toBe("hello");
    expect((await second.state.isEmpty()).unwrap()).toBe(false);
    await second.close();
  });
});
