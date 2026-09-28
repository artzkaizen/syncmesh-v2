import type { CellValue, JsonValue } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { AnyColumn, ColumnKind } from "./column.js";
import type { StandardIssue, StandardSchemaV1 } from "./standard-schema.js";

export class NullConstraintViolation extends TaggedError("NullConstraintViolation")<{
  message: string;
}> {}

export class KindMismatch extends TaggedError("KindMismatch")<{
  expected: ColumnKind;
  message: string;
}> {}

export class CheckFailed extends TaggedError("CheckFailed")<{
  issues: readonly StandardIssue[];
  message: string;
}> {}

export type ColumnError = NullConstraintViolation | KindMismatch | CheckFailed;

export const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* oxlint-disable anti-slop/no-runtime-typeof -- validation is the I/O boundary: the runtime type of a received value is the fact being checked */
const accepts = {
  text: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isSafeInteger(v),
  float: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  timestamp: (v) => typeof v === "number" && Number.isFinite(v),
  json: (v) => !(v instanceof Uint8Array),
  blob: (v) => v instanceof Uint8Array,
  uuid: (v) => typeof v === "string" && UUID_CANONICAL.test(v),
} satisfies Readonly<Record<ColumnKind, (v: CellValue) => boolean>>;
/**
 * A `counter` column's two wire shapes (book ch. 2): the increment an event carries, and the
 * per-author totals a snapshot carries. Everything else about the column stays `integer`.
 */
const safeTotals = (side: JsonValue | undefined): boolean =>
  side !== null &&
  side !== undefined &&
  typeof side === "object" &&
  !Array.isArray(side) &&
  Object.values(side).every((n) => typeof n === "number" && Number.isSafeInteger(n));

const acceptsCounter = (value: CellValue): boolean => {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return false;
  if (Array.isArray(value)) return false;
  if ("+" in value) return typeof value["+"] === "number" && Number.isSafeInteger(value["+"]);
  // SAFETY: a non-array, non-bytes object CellValue is a JSON object, so its values are JsonValues
  const held = value as Readonly<Record<string, JsonValue>>;
  return (
    Object.keys(held).every((k) => k === "p" || k === "n") && Object.values(held).every(safeTotals)
  );
};

/** The text of a scalar cell — a string itself, a finite number in decimal — or `undefined` for anything else. */
export const scalarText = (value: CellValue | undefined): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Validates one wire value against its column: nullability first, then the kind, then the schema.
 * Runs on every peer before the fold, so it is synchronous and never throws.
 */
export function checkValue(
  column: AnyColumn,
  value: CellValue | undefined,
): Result<void, ColumnError> {
  const { kind, nullable, check } = column.def;
  if (value === null || value === undefined) {
    return nullable && value === null
      ? Result.ok(undefined)
      : Result.err(
          new NullConstraintViolation({
            message: nullable ? "undefined is not null" : "column is not nullable",
          }),
        );
  }
  if (column.def.merge === "counter") {
    return acceptsCounter(value)
      ? Result.ok(undefined)
      : Result.err(
          new KindMismatch({ expected: kind, message: "expected a counter increment or totals" }),
        );
  }
  if (!accepts[kind](value))
    return Result.err(new KindMismatch({ expected: kind, message: `expected ${kind}` }));
  return check === undefined ? Result.ok(undefined) : runCheck(check, value);
}

function runCheck(schema: StandardSchemaV1, value: CellValue): Result<void, CheckFailed> {
  const outcome = schema["~standard"].validate(value);
  if (outcome instanceof Promise) {
    return Result.err(
      new CheckFailed({ issues: [], message: "validators must be synchronous: the fold is" }),
    );
  }
  if (outcome.issues === undefined) return Result.ok(undefined);
  return Result.err(
    new CheckFailed({
      issues: outcome.issues,
      message: outcome.issues.map((i) => i.message).join("; "),
    }),
  );
}
