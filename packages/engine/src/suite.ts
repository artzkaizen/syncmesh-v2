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
