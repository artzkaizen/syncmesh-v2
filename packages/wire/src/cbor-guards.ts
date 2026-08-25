import type { CborValue } from "./cbor.js";

/* oxlint-disable anti-slop/no-runtime-typeof -- decoding is the I/O boundary; these are the parsers */
export const isString = (v: CborValue | undefined): v is string => typeof v === "string";
export const isSafeNonNegative = (v: CborValue | undefined): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const isBoolean = (v: CborValue | undefined): v is boolean => typeof v === "boolean";
export const isNumber = (v: CborValue | undefined): v is number => typeof v === "number";
/* oxlint-enable anti-slop/no-runtime-typeof */
