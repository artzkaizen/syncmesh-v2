/**
 * A benchmark that fails, rather than one that reports.
 *
 * `bench/` already measures; what it could not do is *refuse*. Every scale bug this repo has hit
 * looked correct, type-checked, and passed the whole suite — because the suite runs on fixtures
 * small enough that an O(n²) fold and an O(1) fold cost the same. A number in a README does not
 * catch that. A number nobody re-measures after the code changes catches it even less.
 *
 * **The assertion is on the shape of the curve, not on the clock.** An absolute budget in
 * microseconds is a promise about somebody's laptop: it varies threefold across machines, so it
 * is either so loose it catches nothing or so tight it fails on a busy CI runner, and either way
 * it gets deleted within a month. A *ratio* between two sizes on the same machine in the same run
 * cancels the machine out. Declaring that `applyChange` costs the same at 16,000 rows as at 1,000
 * is a claim about the algorithm, it is true on every machine, and it is exactly the claim the
 * copy-the-whole-map fold breaks.
 *
 * A budget is still accepted, and it answers the other question: `counts` is *allowed* to be
 * linear — an aggregate scans — but a linear scan with no index behind it is linear and far too
 * slow. The class catches the wrong algorithm; the budget catches the missing index.
 */

/** How a path's **per-call** cost may move as the data behind it grows. */
export type Growth =
  /** Untouched by size. A fold step, a point read, a merge of one cell into a table of any size. */
  | "constant"
  /** Proportional to size, and no worse. An encoder over its payload, an aggregate over its rows. */
  | "linear";

/** Each size is this many times the one before it, so a ratio has one expected value per class. */
const FACTOR = 4;

/**
 * How far past the expected ratio a path may drift before it is called a regression.
 *
 * Generous on purpose. A microbenchmark on a shared runner is noisy at the small end, where a
 * few hundred nanoseconds of scheduler jitter is a large fraction of the measurement, and a gate
 * that cries wolf is a gate somebody turns off. The bugs this exists to catch are not 1.6× — the
 * fold is 4.3× where it should be 1, the CBOR writer is two orders out. Nothing worth catching
 * lives in the margin, so the margin is set wide enough to never argue about.
 */
const TOLERANCE = 1.6;

export interface ScalePath<Fixture> {
  readonly name: string;
  /**
   * Why this class is the right one — quoted back verbatim when the path fails.
   *
   * A regression reads as "measured 4.3×, expected 1×", which says what happened and nothing
   * about what was meant. The sentence here is what turns that into a diagnosis, and writing it
   * is also the moment somebody has to decide what they are actually claiming.
   */
  readonly because: string;
  readonly growth: Growth;
  /** Ascending, each {@link FACTOR}× the last. Two is enough; three reads the curve rather than a pair. */
  readonly sizes: readonly number[];
  /** Built once per size and excluded from the measurement. */
  readonly prepare: (size: number) => Fixture | Promise<Fixture>;
  /** The one call under test. Everything else belongs in `prepare`; the result is discarded. */
  readonly run: (fixture: Fixture) => void;
  /** Per-call ceiling at the largest size, in microseconds. Absent means the curve is the whole claim. */
  readonly budget?: number;
}

/**
 * A declared path with its fixture type closed over, so one array can hold paths that prepare
 * different things.
 *
 * `at(size)` does the preparing and hands back the call to time, which is what erases the type
 * without an assertion: the fixture never appears in this interface, so there is nothing to cast
 * and nothing for a reader to take on trust.
 */
export interface ScaleRun {
  readonly name: string;
  readonly because: string;
  readonly growth: Growth;
  readonly sizes: readonly number[];
  readonly budget?: number | undefined;
  /** Prepares the fixture for `size` — untimed — and returns the one call to measure. */
  readonly at: (size: number) => Promise<() => void>;
}

/** Declares one path. The generic is inferred from `prepare` and never written at a call site. */
export const path = <Fixture>(declared: ScalePath<Fixture>): ScaleRun => ({
  name: declared.name,
  because: declared.because,
  growth: declared.growth,
  sizes: declared.sizes,
  budget: declared.budget,
  at: async (size) => {
    const fixture = await declared.prepare(size);
    return () => {
      declared.run(fixture);
    };
  },
});

interface Measured {
  readonly size: number;
  /** Microseconds per call. */
  readonly each: number;
}

/**
 * The cost of one call, as the **fastest** of several rounds rather than the mean.
 *
 * A microbenchmark's slow samples are the machine's, not the code's: a GC pause, a steal, another
 * package's test suite landing on the same core. Those only ever add time, so the minimum is the
 * closest this can get to what the code costs when nothing is in its way — and it is far steadier
 * across runs than a mean, which is what a gate needs to not be flaky.
 */
const measure = (run: () => void, iterations: number): number => {
  let best = Infinity;
  for (let round = 0; round < 5; round += 1) {
    for (let i = 0; i < Math.min(iterations, 100); i += 1) run();
    const started = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) run();
    const each = (Bun.nanoseconds() - started) / iterations / 1_000;
    if (each < best) best = each;
  }
  return best;
};

/** Iterations chosen so a round lasts long enough to be a measurement rather than a timer read. */
const iterationsFor = (each: number): number =>
  each > 500 ? 50 : each > 50 ? 500 : each > 5 ? 5_000 : 50_000;

export interface Finding {
  readonly name: string;
  readonly because: string;
  readonly growth: Growth;
  readonly measured: readonly Measured[];
  /** Consecutive per-call ratios; one fewer than `measured`. */
  readonly ratios: readonly number[];
  readonly expected: number;
  readonly worst: number;
  readonly overBudget: number | undefined;
  readonly failed: boolean;
}

const fixed = (n: number, places = 2): string => (n >= 1000 ? n.toFixed(0) : n.toFixed(places));

async function walk(declared: ScaleRun): Promise<Finding> {
  const measured: Measured[] = [];
  for (const size of declared.sizes) {
    const run = await declared.at(size);
    // one untimed call to size the loop, so a 900 µs path is not run 50,000 times
    const probe = measure(run, 3);
    measured.push({ size, each: measure(run, iterationsFor(probe)) });
  }

  const ratios = measured
    .slice(1)
    .map((point, index) => point.each / (measured[index]?.each ?? point.each));
  const expected = declared.growth === "constant" ? 1 : FACTOR;
  const worst = ratios.length === 0 ? expected : Math.max(...ratios);
  const last = measured.at(-1);
  const overBudget =
    declared.budget !== undefined && last !== undefined && last.each > declared.budget
      ? last.each
      : undefined;

  return {
    name: declared.name,
    because: declared.because,
    growth: declared.growth,
    measured,
    ratios,
    expected,
    worst,
    overBudget,
    failed: worst > expected * TOLERANCE || overBudget !== undefined,
  };
}

/**
 * Runs every declared path and prints one block each, failing the process on the first
 * regression it can name.
 *
 * Exits non-zero so this can be a CI step rather than a thing somebody remembers to read.
 */
/* oxlint-disable no-console -- this is the reporter: its output to a terminal and a CI log is
   the whole product, and a gate that wrote its findings anywhere else would not be read */
export async function runScale(paths: readonly ScaleRun[]): Promise<void> {
  const findings: Finding[] = [];
  for (const declared of paths) findings.push(await walk(declared));

  for (const found of findings) {
    const mark = found.failed ? "FAIL" : "ok  ";
    console.log(`\n${mark}  ${found.name}   — per call must be ${found.growth} in size`);
    for (const point of found.measured)
      console.log(
        `        ${point.size.toLocaleString().padStart(9)} → ${fixed(point.each).padStart(9)} µs`,
      );
    const curve = found.ratios.map((r) => `${r.toFixed(1)}×`).join(", ");
    console.log(
      `        growth ${curve || "—"} per ${FACTOR}× of size; ${found.expected}× is the claim`,
    );
    if (found.failed) {
      console.log(`        ${found.because}`);
      if (found.overBudget !== undefined)
        console.log(
          `        over budget: ${fixed(found.overBudget)} µs per call at the largest size`,
        );
    }
  }

  const failed = findings.filter((found) => found.failed);
  console.log(`\n${findings.length - failed.length}/${findings.length} paths hold their shape.`);
  if (failed.length > 0) {
    console.log(`regressed: ${failed.map((found) => found.name).join(", ")}`);
    process.exitCode = 1;
  }
}
/* oxlint-enable no-console */
