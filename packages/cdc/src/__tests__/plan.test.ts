import type { Engine } from "@syncmesh/engine";
import type { Change } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { ChangeMessage } from "../source.js";

import { heldRows } from "../apply.js";
import { meshCells, rowKey } from "../mapping.js";
import { planTransaction } from "../plan.js";
import { ACME, TASKS, authority, mappings, peerAt, WRITE } from "./fixtures.js";

const plan = (engine: Engine, messages: readonly ChangeMessage[]) =>
  planTransaction({ mappings, held: heldRows(engine) }, messages).unwrap();

/** One planned change per partition, flattened to what the assertions are actually about. */
const netEffect = (changes: readonly Change[]) =>
  changes.map((change) => ({
    kind: change.kind,
    columns:
      change.kind === "insert"
        ? [...change.row.keys()].map(String)
        : change.kind === "update"
          ? [...change.patch.keys()].map(String)
          : [],
  }));

/** A row this peer already holds, so the plan has a partition to read and a record to disagree with. */
const held = async (): Promise<Engine> => {
  const engine = peerAt(authority);
  (
    await engine.mutate(
      WRITE,
      (tx) =>
        tx.insert(
          TASKS,
          rowKey("t1"),
          meshCells(mappings.tasks.collection, {
            id: "t1",
            orgId: "acme",
            title: "original",
            ownerId: "acct_alice",
          }),
        ),
      { partition: ACME },
    )
  ).unwrap();
  return engine;
};

describe("what a row's net effect is", () => {
  test("a delete and a re-insert of one key is an insert, not a patch over the deleted row", async () => {
    const engine = await held();
    const planned = plan(engine, [
      { t: "delete", table: "tasks", key: "t1" },
      { t: "insert", table: "tasks", row: { id: "t1", orgId: "acme", ownerId: "acct_bob" } },
    ]);

    // planned as an update, every column the new row omits would keep the deleted row's value —
    // `title: "original"` on a row the database re-created without one, forever
    expect(planned).toHaveLength(1);
    expect(netEffect(planned[0]?.changes ?? [])).toEqual([
      { kind: "insert", columns: ["id", "orgId", "ownerId"] },
    ]);
  });

  test("an ordinary update over a held row stays an update, so a patch is still a patch", async () => {
    const engine = await held();
    const planned = plan(engine, [
      { t: "update", table: "tasks", key: "t1", after: { id: "t1", orgId: "acme", title: "next" } },
    ]);

    expect(netEffect(planned[0]?.changes ?? [])).toEqual([
      { kind: "update", columns: ["id", "orgId", "title"] },
    ]);
  });

  test("deleted, re-inserted and deleted again still tombstones the row this peer held", async () => {
    const engine = await held();
    const planned = plan(engine, [
      { t: "delete", table: "tasks", key: "t1" },
      { t: "insert", table: "tasks", row: { id: "t1", orgId: "acme", title: "brief" } },
      { t: "delete", table: "tasks", key: "t1" },
    ]);

    expect(netEffect(planned[0]?.changes ?? [])).toEqual([{ kind: "delete", columns: [] }]);
  });

  test("born and gone inside one transaction is still nothing at all", async () => {
    const engine = peerAt(authority);
    const planned = plan(engine, [
      { t: "insert", table: "tasks", row: { id: "t9", orgId: "acme", title: "brief" } },
      { t: "delete", table: "tasks", key: "t9" },
      { t: "insert", table: "tasks", row: { id: "t9", orgId: "acme", title: "again" } },
      { t: "delete", table: "tasks", key: "t9" },
    ]);

    expect(planned).toEqual([]);
  });
});
