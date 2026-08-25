import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { t, type ValueOf } from "../column.js";

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

  test("value types are inferred, nullable adds null, check narrows, jsonOf infers from the schema", () => {
    assertType<Equal<ValueOf<ReturnType<typeof t.text>>, string>>();
    assertType<Equal<ValueOf<ReturnType<typeof t.integer>>, number>>();
    assertType<Equal<ValueOf<ReturnType<typeof t.timestamp>>, Temporal.Instant>>();
    assertType<Equal<ValueOf<ReturnType<typeof t.blob>>, Uint8Array>>();
    const note = t.text().nullable();
    assertType<Equal<ValueOf<typeof note>, string | null>>();
    const status = t.text().check(z.enum(["open", "done"]));
    assertType<Equal<ValueOf<typeof status>, "open" | "done">>();
    const meta = t.jsonOf(z.object({ tags: z.array(z.string()) }));
    assertType<Equal<ValueOf<typeof meta>, { tags: string[] }>>();
    const tags = t.json<string[]>();
    assertType<Equal<ValueOf<typeof tags>, string[]>>();
    expect(true).toBe(true);
  });

  test("default takes the app-facing type", () => {
    t.boolean().default(false);
    // SAFETY: type-level test only; the value is never used at runtime
    t.timestamp().default({} as Temporal.Instant);
    // @ts-expect-error a number is not a boolean
    t.boolean().default(0);
    expect(true).toBe(true);
  });
});
