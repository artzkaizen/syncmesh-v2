import { Temporal } from "@syncmesh/temporal";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Many runs: every seed in a range under every named set of switches, one process each.
 *
 * `bun run src/soak.ts --seeds 1..20 --switches none,grants,blobs,retention --devices 6 --ticks 25`
 *
 * A process per run so a run that hangs or crashes is one red row rather than the end of the
 * soak, and so each run's ledger lands in its own `.chaos/run-*` directory exactly as a single
 * `run.ts` would leave it. Prints a table and writes it to `.chaos/soak.txt`; exits non-zero when
 * any run did.
 */

/** The switch sets a soak can name, as the `run.ts` flags that turn them on. */
const SWITCHES = {
  none: [],
  grants: ["--grants", "fault"],
  blobs: ["--blobs"],
  retention: ["--retention"],
  all: ["--grants", "fault", "--blobs", "--retention"],
} as const satisfies Record<string, readonly string[]>;

type SwitchSet = keyof typeof SWITCHES;

/** The package directory: where `run.ts` runs from, so every `.chaos/` output lands in one place. */
const ROOT = join(import.meta.dir, "..");

const isSwitchSet = (name: string): name is SwitchSet => Object.hasOwn(SWITCHES, name);

const value = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const number = (name: string, fallback: number): number => {
  const parsed = Number(value(name));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** `a..b`, inclusive, or one seed alone. */
const seedRange = (text: string): readonly number[] => {
  const [from, to = from] = text.split("..").map(Number);
  if (from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to))
    throw new Error(`--seeds wants a..b or one number, got ${text}`);
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
};

interface Row {
  readonly seed: number;
  readonly switches: SwitchSet;
  readonly code: number;
  readonly seconds: number;
  readonly authored: string;
  readonly verdict: string;
  readonly invariant: string;
}

/** The report's own words, picked back out of a run's output for one table row. */
const summarize = (out: string) => ({
  authored: /authored (\d+)/.exec(out)?.[1] ?? "?",
  verdict: out.includes("DIVERGED") ? "diverged" : out.includes("converged") ? "converged" : "?",
  invariant:
    /(\d+) refused, (\d+) violation\(s\); digests (agree|disagree on \d+)/
      .exec(out)
      ?.slice(1)
      .join("/") ?? "?",
});

async function runOne(
  seed: number,
  switches: SwitchSet,
  options: {
    readonly devices: number;
    readonly ticks: number;
    readonly timeout: Temporal.Duration;
  },
): Promise<Row> {
  const started = performance.now();
  const ran = Bun.spawn(
    [
      "bun",
      "src/run.ts",
      "--seed",
      `${seed}`,
      "--devices",
      `${options.devices}`,
      "--ticks",
      `${options.ticks}`,
      ...SWITCHES[switches],
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => ran.kill(), options.timeout.total("milliseconds"));
  const [code, out, err] = await Promise.all([
    ran.exited,
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
  ]);
  clearTimeout(timer);
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  const timedOut = ran.signalCode !== null;
  const row = { seed, switches, code, seconds, ...summarize(out) };
  if (timedOut) return { ...row, verdict: "timed out" };
  if (code !== 0 && row.verdict === "?")
    process.stderr.write(`seed ${seed} ${switches}:\n${err}\n`);
  return row;
}

const table = (rows: readonly Row[]): string => {
  const header = [
    "seed",
    "switches",
    "exit",
    "secs",
    "authored",
    "verdict",
    "refused/violations/digests",
  ];
  const cells = rows.map((row) => [
    `${row.seed}`,
    row.switches,
    `${row.code}`,
    `${row.seconds}`,
    row.authored,
    row.verdict,
    row.invariant,
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...cells.map((line) => line[i]?.length ?? 0)),
  );
  const line = (values: readonly string[]) =>
    values
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const failed = rows.filter((row) => row.code !== 0);
  return [
    line(header),
    ...cells.map(line),
    "",
    `${rows.length} run(s), ${failed.length} failed${failed.length === 0 ? "" : `: ${failed.map((row) => `${row.seed}/${row.switches}`).join(" ")}`}`,
  ].join("\n");
};

const main = async () => {
  const seeds = seedRange(value("seeds") ?? "1..5");
  const names = (value("switches") ?? "none").split(",");
  const unknown = names.filter((name) => !isSwitchSet(name));
  if (unknown.length > 0)
    throw new Error(
      `unknown switch set(s) ${unknown.join(",")}: one of ${Object.keys(SWITCHES).join(",")}`,
    );
  const sets = names.filter(isSwitchSet);
  const options = {
    devices: number("devices", 6),
    ticks: number("ticks", 25),
    timeout: Temporal.Duration.from({ seconds: number("timeout", 300) }),
  };
  const jobs = number("jobs", 1);

  const queue = seeds.flatMap((seed) => sets.map((switches) => ({ seed, switches })));
  const rows: Row[] = [];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const row = await runOne(next.seed, next.switches, options);
      process.stdout.write(
        `${row.code === 0 ? "pass" : "FAIL"} seed ${row.seed} ${row.switches} (${row.seconds}s) ${row.verdict} ${row.invariant}\n`,
      );
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  rows.sort((a, b) => a.seed - b.seed || a.switches.localeCompare(b.switches));
  const text = table(rows);
  mkdirSync(join(ROOT, ".chaos"), { recursive: true });
  writeFileSync(join(ROOT, ".chaos", "soak.txt"), `${text}\n`);
  process.stdout.write(`\n${text}\n`);
  if (rows.some((row) => row.code !== 0)) process.exitCode = 1;
};

await main();
