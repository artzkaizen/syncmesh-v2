import type { CellValue } from "@syncmesh/kernel";

import { jsonObject, readSet } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { AnyColumn, ColumnDef, ColumnKind } from "./column.js";
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
  /** A cell of merge state, not a total: a bare number here would read back as an empty counter. */
  counter: (v) => jsonObject(v) !== undefined,
  /** As `counter`: the cell holds the ids, not the elements a reader sees. */
  set: (v) => jsonObject(v) !== undefined,
} satisfies Readonly<Record<ColumnKind, (v: CellValue) => boolean>>;
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
  if (!accepts[kind](value))
    return Result.err(new KindMismatch({ expected: kind, message: `expected ${kind}` }));
  if (kind === "set") return checkElements(column.def, value);
  return check === undefined ? Result.ok(undefined) : runCheck(check, value);
}

/**
 * Every live element of a set cell against the column the set was declared over. Tombstones carry
 * no element and are skipped, and an unreadable entry was already dropped by `readSet` — so this
 * reaches exactly the values a reader would see, and reaches them identically on every peer.
 */
function checkElements(def: ColumnDef, value: CellValue): Result<void, ColumnError> {
  const element = def.element;
  if (element === undefined) return Result.ok(undefined);
  const column = { def: element };
  for (const entry of Object.values(readSet(value))) {
    if (entry.length === 0) continue;
    const outcome = checkValue(column, entry[0] ?? null);
    if (outcome.isErr()) return outcome;
  }
  return Result.ok(undefined);
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
