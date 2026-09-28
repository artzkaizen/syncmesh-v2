import { bytesEqual } from "@syncmesh/wire";

/** An expectation of a shipped conformance suite (driver tests, transport tests) that did not hold. */
export class SuiteFailure extends Error {}

/** One named case of a shipped suite, runnable by any test runner: `for (const c of cases) test(c.name, c.run)`. */
export interface SuiteCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SuiteFailure(message);
}

type Leaf = string | number | boolean | null | undefined;
type Comparable = Leaf | Uint8Array | readonly Comparable[];

const same = (a: Comparable, b: Comparable): boolean => {
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b);
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => same(x, b[i]))
    );
  return a === b;
};

const show = (value: Comparable): string =>
  value instanceof Uint8Array ? `bytes(${value.length})` : JSON.stringify(value);

export function equal(actual: Comparable, expected: Comparable, label: string): void {
  check(same(actual, expected), `${label}: expected ${show(expected)}, got ${show(actual)}`);
}

// SAFETY: a prototype is an object or null; `getPrototypeOf` is merely typed `any`
const parentOf = <Value extends object>(value: Value) =>
  Object.getPrototypeOf(value) as object | null;

/** The names a caller can reach on `value` that `{ ...value }` would not carry. */
const lostInSpread = <Value extends object>(value: Value): readonly string[] => {
  const copied = new Set(Object.keys(value));
  const reachable = new Set<string>();
  for (
    let link: object | null = value;
    link !== null && link !== Object.prototype;
    link = parentOf(link)
  )
    for (const name of Object.getOwnPropertyNames(link))
      if (name !== "constructor") reachable.add(name);
  return [...reachable].filter((name) => !copied.has(name)).sort();
};

/**
 * Asserts every member of a seam value is an own enumerable property, so a wrapper built as
 * `{ ...value, member }` carries all of it (D29).
 *
 * @throws {SuiteFailure} Naming each member a spread would drop.
 */
export function spreadable<Value extends object>(value: Value, label: string): void {
  const lost = lostInSpread(value);
  check(
    lost.length === 0,
    `${label}: a wrapper that spreads this value would drop ${lost.join(", ")} — a member on a prototype, or a non-enumerable property, is not copied by { ...value } (D29)`,
  );
}
