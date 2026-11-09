import type { Engine } from "@syncmesh/engine";
import type { Change } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import type { ChangeMessage } from "../source.js";

import { applyPlan, heldRows } from "../apply.js";
import { meshCells, rowKey } from "../mapping.js";
import { planTransaction } from "../plan.js";
import { cdcAllow } from "../rules.js";
import { ACME, TASKS, authority, clock, grants, mappings, peerAt, WRITE } from "./fixtures.js";

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

  test("an update to a held row is filed in the instance the row was born in, whatever it carries", async () => {
    const engine = await held();
    // a staged update carries only what changed, and a database may move the column the mapping
    // reads: neither may send the update to an instance whose peers never held the row
    const planned = plan(engine, [
      { t: "update", table: "tasks", key: "t1", after: { title: "patched" } },
    ]);
    const moved = plan(engine, [
      { t: "update", table: "tasks", key: "t1", after: { id: "t1", orgId: "globex" } },
    ]);

    expect(planned.map((event) => event.partition)).toEqual([ACME]);
    expect(moved.map((event) => event.partition)).toEqual([ACME]);
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

describe("a retired column (D31) the database still holds", () => {
  /** v2 retired `legacy`; Postgres keeps it until the contract step, so every row still carries it. */
  const org = partition("org", { roles: ladder("system", "admin", "viewer") });
  const retiring = syncSchema({
    schemaVersion: 2,
    tables: {
      tasks: {
        columns: {
          id: t.text().primaryKey(),
          orgId: t.text(),
          title: t.text(),
          legacy: t.text().nullable().retired(),
        },
        partition: org,
        allow: ({ role }) => cdcAllow({ read: role("viewer"), writer: "system" }),
      },
    },
  });
  const retiredMappings = {
    tasks: { collection: retiring.tables.tasks, partition: mappings.tasks.partition },
  };

  test("is left out of every CDC insert and update, so the authority's writes are not refused", async () => {
    const engine = createEngine({
      peerId: authority.peerId,
      clock: clock(),
      store: createMemoryEventStore(),
      merge: retiring.merge,
      validate: createValidator({
        schema: retiring,
        grantFor: (peer) => grants.get(peer),
        authority: authority.peerId,
      }),
    });
    const planOf = (messages: readonly ChangeMessage[]) =>
      planTransaction({ mappings: retiredMappings, held: heldRows(engine) }, messages).unwrap();
    const apply = (messages: readonly ChangeMessage[]) =>
      applyPlan({ engine, source: "pg", procedure: WRITE }, planOf(messages), null);

    const inserted = [
      { t: "insert", table: "tasks", row: { id: "t1", orgId: "acme", title: "a", legacy: "x" } },
    ] satisfies ChangeMessage[];
    expect(netEffect(planOf(inserted)[0]?.changes ?? [])).toEqual([
      { kind: "insert", columns: ["id", "orgId", "title"] },
    ]);
    expect((await apply(inserted)).isOk()).toBe(true);

    const updated = [
      {
        t: "update",
        table: "tasks",
        key: "t1",
        after: { id: "t1", orgId: "acme", title: "b", legacy: "x" },
      },
    ] satisfies ChangeMessage[];
    expect(netEffect(planOf(updated)[0]?.changes ?? [])).toEqual([
      { kind: "update", columns: ["id", "orgId", "title"] },
    ]);
    expect((await apply(updated)).isOk()).toBe(true);
  });
});
