/**
 * A zod regex as a JSON Schema `pattern` another runtime's engine reads alike (gap U3): never
 * accepting less than JavaScript does.
 */

/** Regex flags whose meaning a JSON Schema `pattern` cannot carry. */
const UNSAID_FLAGS = /[imsv]/;

/** Escapes a port's regex reads as JavaScript does, with or without `u`. */
const SAME_ESCAPES = new Set("tnrfvx^$\\.*+?()[]{}|/-");

/** JavaScript's `\s`, spelled out: a port's own `\s` is Unicode's `White_Space`, which differs. */
const WHITESPACE = "\\t\\n\\v\\f\\r    -     　﻿";

/**
 * JavaScript's shorthand classes and `.` as the literal sets they stand for. A port reads a
 * shorthand by its own engine's rules (Unicode `\d`, `\w`, `\s`), and the jsonschema crate
 * translates them to JavaScript's only in a pattern with no lookaround, so the set travels
 * spelled.
 */
const SPELLED = new Map([
  ["d", "[0-9]"],
  ["w", "[A-Za-z0-9_]"],
  ["s", `[${WHITESPACE}]`],
  ["D", "[^0-9]"],
  ["W", "[^A-Za-z0-9_]"],
  ["S", `[^${WHITESPACE}]`],
]);

/** The shorthands a class can hold spelled; a negated one cannot be said inside a class. */
const SPELLED_IN_CLASS = new Map([
  ["d", "0-9"],
  ["w", "A-Za-z0-9_"],
  ["s", WHITESPACE],
]);

/** `.` without the `s` flag: anything but a line terminator. */
const DOT = "[^\\n\\r  ]";

/** Escapes that match one UTF-16 unit without `u`, half of a character outside the BMP. */
const UNIT_ESCAPES = new Set("DWS");

/** What may follow `(?` in a pattern a port runs as JavaScript does: a plain group, a lookahead. */
const SAME_GROUPS = new Set(":=!");

const isSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdfff;

/** Where {@link spelledPattern} stands in a pattern's source. */
interface PatternScan {
  readonly source: string;
  /** No `u` flag: `.` and its kin match one UTF-16 unit. */
  readonly units: boolean;
  at: number;
  inClass: boolean;
  /** The open class can match half a surrogate pair. */
  unitClass: boolean;
  /** The atom just read can match half a surrogate pair: only `*` may follow it. */
  unitAtom: boolean;
}

/** Class-set operators a port's engine reads where JavaScript without `v` reads two literals. */
const CLASS_SET_OPERATORS = /[&~-]/;

/** What one scanned piece says to a port, or `undefined` when a port could read it otherwise. */
type Spelled = string | undefined;

const spelledEscape = (scan: PatternScan): Spelled => {
  scan.at += 1;
  const { source, at, inClass, units } = scan;
  const escaped = source.charAt(at);
  // a spelled set beside a `-` would turn into a range's end
  const ranged = source.charAt(at - 2) === "-" || source.charAt(at + 1) === "-";
  const spelled = inClass ? SPELLED_IN_CLASS.get(escaped) : SPELLED.get(escaped);
  if (spelled !== undefined) {
    if (!inClass && units && UNIT_ESCAPES.has(escaped)) scan.unitAtom = true;
    return inClass && ranged ? undefined : spelled;
  }
  return SAME_ESCAPES.has(escaped) ? `\\${escaped}` : undefined;
};

const spelledInClass = (scan: PatternScan, char: string): Spelled => {
  const next = scan.source.charAt(scan.at + 1);
  if (char === "[" || (CLASS_SET_OPERATORS.test(char) && next === char)) return undefined;
  if (char === "]") {
    scan.inClass = false;
    scan.unitAtom = scan.unitClass;
  }
  return char;
};

const spelledOutside = (scan: PatternScan, char: string): Spelled => {
  const { source, units } = scan;
  const next = source.charAt(scan.at + 1);
  if (char === "[") {
    scan.inClass = true;
    scan.unitClass = units && next === "^";
    if (next === "^") scan.at += 1;
    if (source.charAt(scan.at + 1) === "]") return undefined;
    return next === "^" ? "[^" : "[";
  }
  if (char === "(" && next === "?" && !SAME_GROUPS.has(source.charAt(scan.at + 2))) {
    return undefined;
  }
  // JavaScript reads `{,n}` as the literal text; a port's engine as a count
  if (char === "{" && next === ",") return undefined;
  if (char !== ".") return char;
  scan.unitAtom = units;
  return DOT;
};

/** Reads one character into what a port runs. */
const spelledChar = (scan: PatternScan, char: string): Spelled => {
  if (scan.unitAtom) {
    scan.unitAtom = false;
    return char === "*" ? char : undefined;
  }
  if (scan.units && isSurrogate(scan.source.charCodeAt(scan.at))) return undefined;
  if (char === "\\") return spelledEscape(scan);
  return scan.inClass ? spelledInClass(scan, char) : spelledOutside(scan, char);
};

/**
 * `regex` as a pattern a port's engine, which counts code points, reads as accepting no less
 * than `regex` does; `undefined` when it cannot be said so.
 *
 * `.`, `\d`, `\w`, `\s` and their negations are spelled as the literal sets JavaScript means.
 * Without `u` JavaScript matches `.`, a negated class and `\D`, `\W`, `\S` one UTF-16 unit at a
 * time, so `/^.{2}$/` passes "😀"; such an atom is kept only as a `*` run, which takes the same
 * strings either way. A pattern with a literal outside the BMP, a `\b`, a backreference, a
 * named group, a lookbehind, a `\p` or `\u` escape, a nested or empty class, a negated
 * shorthand inside a class, a `{,n}`, or a flag a pattern cannot carry is left out.
 */
export const spelledPattern = ({ source, flags }: RegExp): Spelled => {
  if (UNSAID_FLAGS.test(flags)) return undefined;
  const scan = {
    source,
    units: !flags.includes("u"),
    at: 0,
    inClass: false,
    unitClass: false,
    unitAtom: false,
  } satisfies PatternScan;
  let spelled = "";
  for (; scan.at < source.length; scan.at += 1) {
    const piece = spelledChar(scan, source.charAt(scan.at));
    if (piece === undefined) return undefined;
    spelled += piece;
  }
  return scan.unitAtom || scan.inClass ? undefined : spelled;
};
