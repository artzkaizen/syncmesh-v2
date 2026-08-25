import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { t, type Value } from "../column.js";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => undefined;

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
