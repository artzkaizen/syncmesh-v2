import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { t, type CounterValue, type SetOf, type Value } from "../column.js";
import { assertType, type Equal } from "./fixtures.js";

describe("compile-time guarantees", () => {
  test("onConflict is typed by the column's value", () => {
    t.integer().onConflict("max");
    t.float().onConflict("min");
    t.text().onConflict("lww");
    // @ts-expect-error max makes no sense for text
    t.text().onConflict("max");
    // @ts-expect-error nor for booleans
    t.boolean().onConflict("min");
    // @ts-expect-error nor for json
    t.json().onConflict("max");
    // @ts-expect-error `counter` is the column's kind, never something onConflict may name
    t.integer().onConflict("counter");
    // @ts-expect-error nor `set`
    t.float().onConflict("set");
    expect(true).toBe(true);
  });

  test("a lattice column has no onConflict to call at all: its kind is the strategy", () => {
    void (() => {
      // @ts-expect-error a counter merges by being a counter
      t.counter().onConflict("max");
      // @ts-expect-error and lww is not a second opinion either
      t.counter().onConflict("lww");
      // @ts-expect-error nor has a set one
      t.set(t.text()).onConflict("lww");
    });
    expect(true).toBe(true);
  });

  test("a lattice column is never null, never a key, and carries no schema of its own", () => {
    void (() => {
      // @ts-expect-error an empty counter is 0, not null
      t.counter().nullable();
      // @ts-expect-error an empty set is [], not null
      t.set(t.text()).nullable();
      // @ts-expect-error a row is not keyed by something that merges
      t.counter().primaryKey();
      // @ts-expect-error a schema here would run against the cell's merge state
      t.counter().check(z.number());
    });
    expect(true).toBe(true);
  });

  test("value types are inferred, nullable adds null, check narrows, json(schema) infers from the schema", () => {
    assertType<Equal<Value<ReturnType<typeof t.text>>, string>>();
    assertType<Equal<Value<ReturnType<typeof t.integer>>, number>>();
    assertType<Equal<Value<ReturnType<typeof t.timestamp>>, Temporal.Instant>>();
    assertType<Equal<Value<ReturnType<typeof t.blob>>, Uint8Array>>();
    const note = t.text().nullable();
    assertType<Equal<Value<typeof note>, string | null>>();
    const status = t.text().check(z.enum(["open", "done"]));
    assertType<Equal<Value<typeof status>, "open" | "done">>();
    const meta = t.json(z.object({ tags: z.array(z.string()) }));
    assertType<Equal<Value<typeof meta>, { tags: string[] }>>();
    const tags = t.json<string[]>();
    assertType<Equal<Value<typeof tags>, string[]>>();
    expect(true).toBe(true);
  });

  test("a counter reads as a number and a set as an array, and neither takes one back", () => {
    assertType<Value<ReturnType<typeof t.counter>> extends number ? true : false>();
    assertType<Value<ReturnType<typeof t.set<string>>> extends readonly string[] ? true : false>();
    assertType<Equal<Value<ReturnType<typeof t.counter>>, CounterValue>>();
    assertType<Equal<Value<ReturnType<typeof t.set<string>>>, SetOf<string>>>();
    void (() => {
      // @ts-expect-error a total is not assignable to a counter: it moves by increment
      const back: Value<ReturnType<typeof t.counter>> = 7;
      void back;
    });
    expect(true).toBe(true);
  });

  test("columns have no default: absence is null or an error, never a filled value", () => {
    void (() => {
      // @ts-expect-error defaults do not sync; there is no .default()
      t.boolean().default(false);
    });
    expect(true).toBe(true);
  });
});

describe("a key column cannot be weakened, at the type level", () => {
  test("nullable is gone after primaryKey; primaryKey is gone after nullable", () => {
    void (() => {
      // @ts-expect-error a key column is required on every row
      t.text().primaryKey().nullable();
      // @ts-expect-error a nullable column cannot become the key
      t.text().nullable().primaryKey();
    });
  });
});
