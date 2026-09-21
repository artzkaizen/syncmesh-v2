/**
 * A `.cpuprofile`, read the two ways that answer a stall.
 *
 * **Self time** says where the JS thread actually was — the function on top of the stack when the
 * sampler looked. **Total time** says which call tree that sits under, which is what turns a hot
 * leaf like `Object.keys` into "the deep compare in the live query".
 *
 * **Density** is the one that settles whether JavaScript was involved at all. Samples arrive at a
 * fixed rate while JS runs and stop when it has nothing to do, so a run of empty buckets across a
 * stall is the JS thread idle and the stall belonging to the native side.
 */

/** Chrome's CPU profile, as Hermes emits it. Times are microseconds. */
export interface CpuProfile {
  readonly nodes: readonly {
    readonly id: number;
    readonly callFrame: {
      readonly functionName: string;
      readonly url?: string;
      readonly lineNumber?: number;
    };
    readonly children?: readonly number[];
  }[];
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

const MS = 1000;

/** A frame's name as a person reads it: the function, and the file it came from. */
const nameOf = (frame: CpuProfile["nodes"][number]["callFrame"]): string => {
  const called = frame.functionName === "" ? "(anonymous)" : frame.functionName;
  const from = frame.url ?? "";
  const file = from.slice(from.lastIndexOf("/") + 1).split("?")[0] ?? "";
  return file === "" ? called : `${called}  ${file}:${String(frame.lineNumber ?? 0)}`;
};

interface Counted {
  readonly what: string;
  readonly ms: number;
}

const ranked = (by: ReadonlyMap<string, number>, top: number): readonly Counted[] =>
  [...by]
    .map(([what, us]) => ({ ms: us / MS, what }))
    .sort((one, other) => other.ms - one.ms)
    .slice(0, top);

/** Every ancestor of each node, so a sample can be charged to the whole tree it sat in. */
const parentsOf = (profile: CpuProfile): ReadonlyMap<number, number> => {
  const up = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) up.set(child, node.id);
  return up;
};

export interface Reading {
  readonly spanMs: number;
  readonly samples: number;
  /** Samples per 100ms, so an idle stretch reads as a run of low counts. */
  readonly density: readonly number[];
  readonly self: readonly Counted[];
  readonly total: readonly Counted[];
}

export const readProfile = (profile: CpuProfile, top = 20): Reading => {
  const named = new Map(profile.nodes.map((node) => [node.id, nameOf(node.callFrame)]));
  const up = parentsOf(profile);
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const spanUs = profile.endTime - profile.startTime;
  const buckets = Math.max(1, Math.ceil(spanUs / MS / 100));
  const density = Array.from({ length: buckets }, () => 0);

  let at = 0;
  for (const [index, node] of profile.samples.entries()) {
    const spent = profile.timeDeltas[index] ?? 0;
    at += spent;
    const bucket = Math.min(buckets - 1, Math.floor(at / MS / 100));
    density[bucket] = (density[bucket] ?? 0) + 1;

    const leaf = named.get(node);
    if (leaf !== undefined) self.set(leaf, (self.get(leaf) ?? 0) + spent);
    // charged once per sample per function, so recursion does not count a frame twice
    const seen = new Set<string>();
    for (let walk: number | undefined = node; walk !== undefined; walk = up.get(walk)) {
      const what = named.get(walk);
      if (what === undefined || seen.has(what)) continue;
      seen.add(what);
      total.set(what, (total.get(what) ?? 0) + spent);
    }
  }

  return {
    density,
    samples: profile.samples.length,
    self: ranked(self, top),
    spanMs: spanUs / MS,
    total: ranked(total, top),
  };
};

/** The density as one line: each character is 100ms, taller marks are busier. */
const sparkline = (density: readonly number[]): string => {
  const marks = " ·▁▂▃▄▅▆▇█";
  const busiest = Math.max(1, ...density);
  return density
    .map((n) => marks[Math.min(marks.length - 1, Math.ceil((n / busiest) * (marks.length - 1)))])
    .join("");
};

export const printReading = (reading: Reading, log: (line: string) => void): void => {
  log(
    `span ${reading.spanMs.toFixed(0)}ms · ${String(reading.samples)} samples · ${(reading.samples / (reading.spanMs / MS)).toFixed(0)}/s`,
  );
  log(`density (one char = 100ms)\n  ${sparkline(reading.density)}`);
  log("\nself time — where the JS thread was");
  for (const { ms, what } of reading.self) log(`  ${ms.toFixed(1).padStart(8)}ms  ${what}`);
  log("\ntotal time — the call trees that sits under");
  for (const { ms, what } of reading.total) log(`  ${ms.toFixed(1).padStart(8)}ms  ${what}`);
};
