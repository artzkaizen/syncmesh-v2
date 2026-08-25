import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    tables: {
      todos: {
        columns: {
          id: t.text().primaryKey(),
          text: t.text(),
          done: t.boolean(),
          rank: t.integer(),
        },
        partition: "local",
      },
    },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const open = () => createMesh({ schema: schema(), identity: device, now: () => T0 });

describe("live queries", () => {
  test("a result enters, moves, updates in place and leaves as rows change", async () => {
    const mesh = open();
    const openTodos = mesh.liveQuery(mesh.todos.list({ where: { done: false }, orderBy: "rank" }));
    let notified = 0;
    openTodos.subscribe(() => void (notified += 1));
    expect(openTodos.data()).toEqual([]);

    (await mesh.todos.insert({ id: "a", text: "one", rank: 2, done: false })).unwrap();
    (await mesh.todos.insert({ id: "b", text: "two", rank: 1, done: false })).unwrap();
    expect(openTodos.data().map((r) => r.id)).toEqual(["b", "a"]);
    expect(notified).toBe(2);

    (await mesh.todos.update("b", { rank: 3 })).unwrap();
    expect(openTodos.data().map((r) => r.id)).toEqual(["a", "b"]);

    (await mesh.todos.update("a", { text: "one!" })).unwrap();
    expect(openTodos.data().map((r) => r.text)).toEqual(["one!", "two"]);

    (await mesh.todos.update("a", { done: true })).unwrap();
    expect(openTodos.data().map((r) => r.id)).toEqual(["b"]);

    (await mesh.todos.delete("b")).unwrap();
    expect(openTodos.data()).toEqual([]);
    expect(notified).toBe(6);
    mesh.releaseQuery(openTodos);
  });

  test("a batch that misses the filter and table does not notify; one batch is one notification", async () => {
    const mesh = open();
    const done = mesh.liveQuery(mesh.todos.list({ where: { done: true } }));
    let notified = 0;
    done.subscribe(() => void (notified += 1));
    (await mesh.todos.insert({ id: "a", text: "x", rank: 1, done: false })).unwrap();
    expect(notified).toBe(0);
    (
      await mesh.tx((c) =>
        c.todos
          .insert({ id: "b", text: "y", rank: 2, done: true })
          .andThen(() => c.todos.insert({ id: "c", text: "z", rank: 3, done: true }))
          .map(() => undefined),
      )
    ).unwrap();
    expect(done.data()).toHaveLength(2);
    expect(notified).toBe(1);
    mesh.releaseQuery(done);
  });

  test("identical descriptors share one maintained result; a predicate never shares; release drops", () => {
    const mesh = open();
    const a = mesh.liveQuery(mesh.todos.list({ where: { done: false }, orderBy: "rank" }));
    const b = mesh.liveQuery(mesh.todos.list({ where: { done: false }, orderBy: "rank" }));
    const c = mesh.liveQuery(mesh.todos.list({ where: (row) => !row.done }));
    expect(mesh.openQueries()).toBe(2);
    mesh.releaseQuery(a);
    expect(mesh.openQueries()).toBe(2);
    mesh.releaseQuery(b);
    mesh.releaseQuery(b);
    expect(mesh.openQueries()).toBe(1);
    mesh.releaseQuery(c);
    expect(mesh.openQueries()).toBe(0);
  });

  test("limit is a window on the handle: two windows share one maintained result", async () => {
    const mesh = open();
    for (const [id, rank] of [
      ["a", 3],
      ["b", 1],
      ["c", 2],
    ] as const) {
      (await mesh.todos.insert({ id, text: id, rank, done: false })).unwrap();
    }
    const top = mesh.liveQuery(mesh.todos.list({ orderBy: "rank", limit: 2 }));
    const whole = mesh.liveQuery(mesh.todos.list({ orderBy: "rank" }));
    expect(mesh.openQueries()).toBe(1);
    expect(top.data().map((r) => r.id)).toEqual(["b", "c"]);
    expect(whole.data().map((r) => r.id)).toEqual(["b", "c", "a"]);
    (await mesh.todos.update("a", { rank: 0 })).unwrap();
    expect(top.data().map((r) => r.id)).toEqual(["a", "b"]);
    mesh.releaseQuery(top);
    mesh.releaseQuery(whole);
    expect(mesh.openQueries()).toBe(0);
  });
});
