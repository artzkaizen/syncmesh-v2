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

export interface ScalePath<Fixture, Out> {
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
  /**
   * The one call under test. Everything else belongs in `prepare`; the result is discarded, and a
   * promise is awaited, so an async path is timed to its settlement.
   */
  readonly run: (fixture: Fixture) => Out;
  /** Per-call ceiling at the largest size, in microseconds. Absent means the curve is the whole claim. */
  readonly budget?: number;
  /** Closes what `prepare` opened — a room's timers, a socket — once the size is measured. */
  readonly release?: (fixture: Fixture) => void | Promise<void>;
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
  /** Prepares the fixture for `size` — untimed — and returns the one call to measure, and its release. */
  readonly at: (size: number) => Promise<Prepared>;
}

/** The call under test, erased: `undefined` when it ran synchronously, its settlement when it did not. */
export type Call = () => Promise<void> | undefined;

/** One size's fixture, closed over: the call to time, and what to run once it has been timed. */
export interface Prepared {
  readonly call: Call;
  readonly release: () => Promise<void>;
}

/** Declares one path. The generics are inferred from `prepare` and `run` and never written at a call site. */
export const path = <Fixture, Out>(declared: ScalePath<Fixture, Out>): ScaleRun => ({
  name: declared.name,
  because: declared.because,
  growth: declared.growth,
  sizes: declared.sizes,
  budget: declared.budget,
  at: async (size) => {
    const fixture = await declared.prepare(size);
    return {
      call: () => {
        const out = declared.run(fixture);
        return out instanceof Promise ? out.then(() => undefined) : undefined;
      },
      release: async () => {
        await declared.release?.(fixture);
      },
    };
  },
});

interface Measured {
  readonly size: number;
  /** Microseconds per call. */
  readonly each: number;
}

/** Calls `run` `times` times, awaiting each answer that is a promise; nanoseconds elapsed. */
const timed = async (run: Call, times: number): Promise<number> => {
  const started = Bun.nanoseconds();
  for (let i = 0; i < times; i += 1) {
    const settling = run();
    if (settling !== undefined) await settling;
  }
  return Bun.nanoseconds() - started;
};

/**
 * How long one timed round lasts. Long enough that a timer read, a scheduler tick or one GC pause
 * is a small fraction of it: at 0.01 µs a call, a round of a few thousand calls is a few
 * microseconds, and one preemption inside it reads as a 3× regression.
 */
const ROUND_NS = 10_000_000;

/** The most calls one round makes, however cheap the call: a ceiling on a round's length. */
const MAX_CALLS = 4_000_000;

/** Rounds per size. The fastest is kept; more rounds give a busy machine more chances to be quiet. */
const ROUNDS = 7;

/**
 * Below this, per call, two sizes are the same cost as far as this gate can tell.
 *
 * A constant path at 10 ns and one at 30 ns differ by the jitter of the loop around them, not by
 * anything the data did; the regressions this gate exists for are tens of microseconds at the
 * largest size (`lastSeq` walking 16,000 events took 70 µs). Ratios are taken over costs raised to
 * this floor, so a path too cheap to measure holds its shape by definition.
 */
const NOISE_FLOOR_US = 0.25;

/**
 * Each size's cost per call in microseconds, as the **fastest** of {@link ROUNDS} rounds.
 *
 * A microbenchmark's slow samples are the machine's, not the code's: a GC pause, a steal, another
 * package's test suite landing on the same core. Those only ever add time, so the minimum is the
 * closest this can get to what the code costs when nothing is in its way.
 *
 * The sizes are **interleaved**, round by round, rather than measured one after another: a burst
 * of load then lands on every size alike instead of on whichever size happened to be running,
 * which is what turned a quiet 1× into a reported 1.8× on a shared runner.
 */
const measure = async (calls: readonly Call[]): Promise<readonly number[]> => {
  const iterations: number[] = [];
  for (const run of calls) {
    // doubled until a round is long enough to read, which also warms the path: a probe of three
    // calls overstates a 10 ns call tenfold and would size its rounds a tenth as long as meant
    let times = 3;
    let took = await timed(run, times);
    while (took < ROUND_NS / 4 && times < MAX_CALLS) {
      times *= 2;
      took = await timed(run, times);
    }
    iterations.push(
      Math.min(Math.max(Math.ceil((times * ROUND_NS) / Math.max(took, 1)), 3), MAX_CALLS),
    );
  }
  const best = calls.map(() => Infinity);
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [index, run] of calls.entries()) {
      const times = iterations[index] ?? 3;
      // a full collection before each round, untimed: otherwise a round over a large fixture
      // pays for collecting that fixture's heap, which grows with the size and reads as growth
      Bun.gc(true);
      const each = (await timed(run, times)) / times / 1_000;
      if (each < (best[index] ?? Infinity)) best[index] = each;
    }
  }
  return best;
};

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
  const prepared: Prepared[] = [];
  for (const size of declared.sizes) prepared.push(await declared.at(size));
  const costs = await measure(prepared.map((p) => p.call));
  for (const p of prepared) await p.release();
  const measured = declared.sizes.map((size, index) => ({ size, each: costs[index] ?? Infinity }));

  const floored = (each: number) => Math.max(each, NOISE_FLOOR_US);
  const ratios = measured
    .slice(1)
    .map((point, index) => floored(point.each) / floored(measured[index]?.each ?? point.each));
  const expected = declared.growth === "constant" ? 1 : FACTOR;
  const worst = ratios.length === 0 ? expected : Math.max(...ratios);
  // first size to last, against the claim compounded over every step: one fast outlier at a
  // middle size inflates the step after it, and leaves this untouched
  const first = measured[0];
  const overall =
    first === undefined || measured.length < 2
      ? 1
      : floored(measured.at(-1)?.each ?? first.each) /
        floored(first.each) /
        expected ** (measured.length - 1);
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
    // a wrong algorithm breaks both: every step past the claim, and the whole curve with it
    failed: (worst > expected * TOLERANCE && overall > TOLERANCE) || overBudget !== undefined,
  };
}

/**
 * How many times a path is walked before it is called a regression: once, and again from fresh
 * fixtures each time it fails. A real regression fails every walk — the copy-per-write fold is
 * 4× on every machine on every attempt — while a burst of load on a shared runner does not land
 * on the same path three times running.
 */
const ATTEMPTS = 3;

/** Walks a path until it holds or has failed {@link ATTEMPTS} times; the last finding, and how many walks. */
async function settle(declared: ScaleRun): Promise<Finding & { readonly attempts: number }> {
  let attempts = 1;
  let found = await walk(declared);
  while (found.failed && attempts < ATTEMPTS) {
    attempts += 1;
    found = await walk(declared);
  }
  return { ...found, attempts };
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
  const findings: (Finding & { readonly attempts: number })[] = [];
  for (const declared of paths) findings.push(await settle(declared));

  for (const found of findings) {
    const mark = found.failed ? "FAIL" : "ok  ";
    console.log(`\n${mark}  ${found.name}   — per call must be ${found.growth} in size`);
    for (const point of found.measured)
      console.log(
        `        ${point.size.toLocaleString().padStart(9)} → ${fixed(point.each).padStart(9)} µs`,
      );
    const curve = found.ratios.map((r) => `${r.toFixed(1)}×`).join(", ");
    console.log(
      `        growth ${curve || "—"} per ${FACTOR}× of size; ${found.expected}× is the claim` +
        (found.attempts > 1 ? ` (walk ${found.attempts} of ${ATTEMPTS})` : ""),
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
