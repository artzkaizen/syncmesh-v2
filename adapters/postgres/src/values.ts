import type { CellValue, JsonValue } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

const INTEGER = /^-?\d+$/;
const TIMESTAMP =
  /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)(?:([+-]\d\d)(?::(\d\d))?(?::(\d\d))?)?$/;

/**
 * A Postgres value as a mesh cell, from its text form — the form both `pgoutput` and a backfill
 * `::text` read produce, so a row reads the same whichever path brought it.
 *
 * Integers, floats and booleans become numbers and booleans; `timestamp` and `timestamptz`
 * become epoch milliseconds, which is a `t.timestamp()` cell (a `timestamp` without a zone is
 * read as UTC); `bytea` becomes bytes; `json` and `jsonb` are parsed. Everything else stays
 * text, and so does any value that would lose something converted — an `int8` beyond 2⁵³, a
 * `NaN`, an `infinity` timestamp — so the collection's own column check refuses it loudly
 * rather than this storing a rounded one.
 */
export function cellValue(type: number, text: string): CellValue {
  const read = READERS.get(type);
  return read === undefined ? text : read(text);
}

const integer = (text: string) => Number(text);

const int8 = (text: string) => {
  const value = INTEGER.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(value) ? value : text;
};

const float = (text: string) => {
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
};

// SAFETY: JSON.parse of Postgres's own json output is a JSON value
const json = (text: string) => Result.try(() => JSON.parse(text) as JsonValue).unwrapOr(text);

const timestamp = (text: string) => epochMilliseconds(text) ?? text;

/** By type OID (`pg_type.oid`, fixed since 8.x); a type absent here is read as text. */
const READERS = new Map<number, (text: string) => CellValue>([
  // `t` from pgoutput, `true` from a `::text` cast
  [16, (text) => text === "t" || text === "true"], // bool
  [
    17,
    (text) => (text.startsWith("\\x") ? new Uint8Array(Buffer.from(text.slice(2), "hex")) : text),
  ], // bytea
  [20, int8],
  [21, integer], // int2
  [23, integer], // int4
  [26, integer], // oid
  [114, json],
  [700, float], // float4
  [701, float], // float8
  [1114, timestamp],
  [1184, timestamp], // timestamptz
  [3802, json], // jsonb
]);

/** `2026-11-07 12:00:00.123456+01` in Postgres's ISO style, as epoch milliseconds. */
function epochMilliseconds(text: string): number | undefined {
  const parts = TIMESTAMP.exec(text);
  if (parts === null) return undefined;
  const [, date, time, hours, minutes, seconds] = parts;
  const offset =
    hours === undefined
      ? "Z"
      : `${hours}:${minutes ?? "00"}${seconds === undefined ? "" : `:${seconds}`}`;
  return Result.try(
    () => Temporal.Instant.from(`${date}T${time}${offset}`).epochMilliseconds,
  ).unwrapOr(undefined);
}
