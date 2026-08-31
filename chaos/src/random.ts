/**
 * A seeded generator, so a run that fails fails the same way again.
 *
 * The whole harness is worth less than nothing without this: a fault found once and never
 * reproduced is a rumour. mulberry32 — small, fast, and good enough for choosing who goes dark.
 */
export const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One of `items`, or `undefined` when there are none. */
export const pick = <T>(random: () => number, items: readonly T[]): T | undefined =>
  items[Math.floor(random() * items.length)];

/** `true` with probability `chance`. */
export const chance = (random: () => number, probability: number): boolean =>
  random() < probability;

/** A whole number in `[min, max]`. */
export const between = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));
