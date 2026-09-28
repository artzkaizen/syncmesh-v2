import type { Hlc } from "@syncmesh/kernel";
import type { ReactNode } from "react";

import type { Severity } from "../tokens.js";

import { Empty, Meter, Row } from "../react/primitives/index.js";
import { since } from "./link-kit.js";

/**
 * The pieces more than one of these three panels turns into something you can see.
 *
 * Two of them are formatters and the rest are shapes, and the split is the point: a figure printed
 * in a cell answers *what is this number*, and only a drawn one answers *is it big*. A log panel is
 * opened with the second question — which author is flooding this, which table is the database,
 * which write has been stuck longest — so everything here that can be a bar is one, and the digits
 * ride along beside it rather than instead of it.
 */

/** Decimal units, because a log's weight gets compared against quotas nobody states in mebibytes. */
const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

export function bytes(count: number): string {
  let left = count;
  let unit = 0;
  while (left >= 1000 && unit < UNITS.length - 1) {
    left /= 1000;
    unit += 1;
  }
  const scale = UNITS[unit] ?? "B";
  return `${unit === 0 ? Math.round(left) : left.toFixed(left < 10 ? 1 : 0)} ${scale}`;
}

/**
 * A hybrid stamp as a time of day and its counter.
 *
 * The date is dropped and the counter is not, which is the opposite of a calendar's priorities and
 * the right way round here: two events in the same millisecond are exactly the pair a reader is
 * trying to order, and the logical counter is the only thing separating them. A zero counter is
 * left off, so the column stays quiet in the common case.
 */
export function stamp(hlc: Hlc): string {
  const [instant, logical] = hlc;
  const time = new Date(instant.epochMilliseconds).toISOString().slice(11, 23);
  return logical === 0 ? time : `${time}+${logical}`;
}

/** A whole as a percentage of another, with nothing over zero rounding to a confident 0%. */
export const share = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.max(part === 0 ? 0 : 1, Math.round((part / whole) * 100));

/**
 * An empty state as a sentence, because an empty panel with no next step looks broken.
 *
 * Title first here, against {@link Empty}'s own prop order, for the one reason that decides which
 * of these a reader ever writes well: the title is the finding and the hint is what to do about
 * it, and putting them in that order at the call site makes the pair hard to leave half-written.
 */
export const note = (title: string, hint: string, icon?: ReactNode) => (
  <Empty hint={hint} icon={icon} title={title} />
);

export interface Bar {
  readonly key: string;
  readonly label: ReactNode;
  readonly meta?: ReactNode | undefined;
  readonly value: number;
  /** Printed at the end of the row; the raw value where a caller gives nothing better. */
  readonly display?: string | undefined;
  readonly severity?: Severity | undefined;
  /** Revealed on hover, as {@link Row} reveals it — a drill-in, never a second figure. */
  readonly action?: ReactNode | undefined;
}

export interface BarsProps {
  readonly rows: readonly Bar[];
  /** The top of the scale. By default the largest row, so the biggest bar always fills its track. */
  readonly max?: number | undefined;
  readonly empty?: ReactNode | undefined;
}

/**
 * A ranked list drawn as meters — the answer to "which of these is the big one".
 *
 * Scaled to the largest row rather than to a total, because these lists are read for their
 * *ranking* and a set of shares of a big total is a row of slivers. The figure stays at the end of
 * every row: the bar is for the eye, the number is for the bug report.
 */
export function Bars({ rows, max, empty }: BarsProps) {
  if (rows.length === 0) return empty ?? null;
  const top = Math.max(1, max ?? Math.max(0, ...rows.map((row) => row.value)));
  return (
    <>
      {rows.map((row) => (
        <Row
          action={row.action}
          key={row.key}
          label={row.label}
          meta={row.meta}
          severity={row.severity}
          trailing={row.display ?? row.value}
        >
          <Meter max={top} severity={row.severity} value={row.value} />
        </Row>
      ))}
    </>
  );
}

/** One count per name, biggest first — the input {@link Bars} is nearly always given. */
export const tally = (names: readonly string[]): readonly Bar[] => {
  const held = new Map<string, number>();
  for (const name of names) held.set(name, (held.get(name) ?? 0) + 1);
  return [...held]
    .sort((left, right) => right[1] - left[1])
    .map(([key, value]) => ({ key, label: key, value }));
};

export interface Window {
  readonly values: readonly number[];
  /** What one bucket spans, in words, for the caption under the run. */
  readonly every: string;
}

/** A window with nothing in it: the track, drawn, and no claim about a span nobody measured. */
const NO_WINDOW = { values: [], every: "nothing yet" } satisfies Window;

/**
 * Counts per bucket across the span the stamps themselves cover, oldest first.
 *
 * The window is the data's own, not a wall clock's, and that is deliberate: these stamps are
 * hybrid clocks from several devices, so anchoring the buckets to *now* would push a page of
 * events from a peer whose clock runs a minute fast into a single edge bar. Spread over their own
 * span, the shape is the shape of the traffic — a catch-up burst, a quiet hour, a write storm.
 */
export function buckets(stamps: readonly number[], count = 40): Window {
  if (stamps.length === 0) return NO_WINDOW;
  const first = Math.min(...stamps);
  const span = Math.max(Math.max(...stamps) - first, 1);
  const values = Array.from({ length: count }, () => 0);
  for (const at of stamps) {
    const slot = Math.min(count - 1, Math.floor(((at - first) / span) * count));
    values[slot] = (values[slot] ?? 0) + 1;
  }
  // `since` from a zero epoch is a duration in the same words every age on these panels uses
  return { values, every: since(0, Math.max(Math.round(span / count), 1000)) };
}
