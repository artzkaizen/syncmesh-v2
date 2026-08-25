import type { CellValue } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { checkValue } from "../check.js";
import { t, type AnyColumn } from "../column.js";

const tag = (column: AnyColumn, value: CellValue | undefined) => {
  const r = checkValue(column, value);
  return r.isOk() ? "ok" : r.error._tag;
};

describe("the accept / reject table", () => {
  test("text: any string; not numbers or objects", () => {
    expect(tag(t.text(), "")).toBe("ok");
    expect(tag(t.text(), "x")).toBe("ok");
    expect(tag(t.text(), 1)).toBe("KindMismatch");
    expect(tag(t.text(), { a: 1 })).toBe("KindMismatch");
  });

  test("integer: safe integers only — 1.5, NaN, Infinity refused", () => {
    expect(tag(t.integer(), 0)).toBe("ok");
    expect(tag(t.integer(), -7)).toBe("ok");
    expect(tag(t.integer(), Number.MAX_SAFE_INTEGER)).toBe("ok");
    for (const bad of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
    ]) {
      expect(tag(t.integer(), bad)).toBe("KindMismatch");
    }
  });

  test("float and timestamp: any finite number", () => {
    for (const col of [t.float(), t.timestamp()]) {
      expect(tag(col, 1.5)).toBe("ok");
      expect(tag(col, -1e12)).toBe("ok");
      expect(tag(col, Number.NaN)).toBe("KindMismatch");
      expect(tag(col, Number.NEGATIVE_INFINITY)).toBe("KindMismatch");
    }
  });

  test("boolean: true/false only — not 0, 1, 'true'", () => {
    expect(tag(t.boolean(), true)).toBe("ok");
    expect(tag(t.boolean(), false)).toBe("ok");
    for (const bad of [0, 1, "true"]) expect(tag(t.boolean(), bad)).toBe("KindMismatch");
  });

  test("uuid: canonical lowercase 8-4-4-4-12 (v4, v7, nil, max); refuses uppercase, braces, anything else — never normalises", () => {
    for (const ok of [
      "123e4567-e89b-42d3-a456-426614174000",
      "018f4b3c-1a2b-7cde-8f90-123456789abc",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ]) {
      expect(tag(t.uuid(), ok)).toBe("ok");
    }
    for (const bad of [
      "123E4567-E89B-42D3-A456-426614174000",
      "{123e4567-e89b-42d3-a456-426614174000}",
      "123e4567e89b42d3a456426614174000",
      "not-a-uuid",
      "",
    ]) {
      expect(tag(t.uuid(), bad)).toBe("KindMismatch");
    }
  });

  test("blob: Uint8Array, zero-length included; not plain arrays", () => {
    expect(tag(t.blob(), new Uint8Array())).toBe("ok");
    expect(tag(t.blob(), Uint8Array.of(1))).toBe("ok");
    expect(tag(t.blob(), [1, 2])).toBe("KindMismatch");
  });

  test("json without a schema: anything JSON, including nested; not bytes", () => {
    expect(tag(t.json(), { a: [1, "x", null, { b: true }] })).toBe("ok");
    expect(tag(t.json(), 3)).toBe("ok");
    expect(tag(t.json(), new Uint8Array())).toBe("KindMismatch");
  });

  test("nullable owns null; non-nullable refuses null and undefined", () => {
    expect(tag(t.text().nullable(), null)).toBe("ok");
    expect(tag(t.text(), null)).toBe("NullConstraintViolation");
    expect(tag(t.text(), undefined)).toBe("NullConstraintViolation");
    expect(tag(t.text().nullable(), undefined)).toBe("NullConstraintViolation");
  });
});

describe("check schemas (Standard Schema, structurally)", () => {
  test("kind check runs first: 1.5 into a checked integer is KindMismatch, not CheckFailed", () => {
    const age = t.integer().check(z.number().int().min(0).max(150));
    expect(tag(age, 1.5)).toBe("KindMismatch");
    expect(tag(age, 200)).toBe("CheckFailed");
    expect(tag(age, 30)).toBe("ok");
  });

  test("jsonOf(schema) checks the contents; nullable still wins for null", () => {
    const meta = t.jsonOf(z.object({ tags: z.array(z.string()), pinned: z.boolean() })).nullable();
    expect(tag(meta, { tags: ["a"], pinned: false })).toBe("ok");
    expect(tag(meta, { tags: "a" })).toBe("CheckFailed");
    expect(tag(meta, null)).toBe("ok");
  });

  test("an async validator fails loudly for every value, never silently passes", () => {
    const email = t.text().check(z.email().refine(async () => true));
    const r = checkValue(email, "a@b.co");
    expect(r.isErr() && r.error._tag).toBe("CheckFailed");
    expect(r.isErr() && r.error.message).toContain("synchronous");
  });

  test("issues are carried on CheckFailed", () => {
    const status = t.text().check(z.enum(["open", "done"]));
    const r = checkValue(status, "nope");
    expect(r.isErr() && r.error._tag === "CheckFailed" && r.error.issues.length).toBeGreaterThan(0);
  });
});

describe("modifiers are data", () => {
  test("each modifier returns a new column; the original is untouched", () => {
    const a = t.integer();
    const b = a.nullable().unique().default(3).onConflict("max");
    expect(a.def).toEqual({
      kind: "integer",
      nullable: false,
      primaryKey: false,
      unique: false,
      hasDefault: false,
    });
    expect(b.def).toMatchObject({
      nullable: true,
      unique: true,
      hasDefault: true,
      defaultValue: 3,
      onConflict: "max",
    });
  });

  test("a timestamp default is stored in wire form (epoch ms)", () => {
    const c = t.timestamp().default(Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000));
    expect(c.def.defaultValue).toBe(1_700_000_000_000);
  });
});
