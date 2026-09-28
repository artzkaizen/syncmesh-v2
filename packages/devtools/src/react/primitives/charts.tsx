import type { Severity } from "../../tokens.js";

import { COLOR, RADIUS, SEVERITY_COLOR, TEXT } from "../../tokens.js";

/**
 * Shapes over time, and shapes over a whole — the two things a meter cannot draw.
 *
 * `Meter` answers *how much of what*, one quantity at a time. Neither of the questions a sync
 * inspector is actually opened with is that shape. "Is this device keeping up" is a **rate over
 * time**: a catch-up burst, a quiet hour and a write storm are three different silhouettes and
 * identical columns of digits. "Is this link healthy" is a **mix**: proven against refused
 * against closed, where the ratio is the whole answer and the totals are noise.
 *
 * Both are drawn flat — no axes, no gridlines, no legend, no animation. A chart in a devtool is
 * read in peripheral vision while the figure beside it does the talking, and every pixel spent on
 * furniture is one not spent on the data. The same reason the meters are 2px.
 */

export interface SparkProps {
  /** Buckets, oldest first. An empty series draws the track and nothing else, which is honest. */
  readonly values: readonly number[];
  /** The top of the scale; by default the tallest bucket, so the shape always fills the box. */
  readonly max?: number;
  readonly height?: number;
  readonly severity?: Severity;
  /**
   * A colour per bucket, where the run is not one quantity but several facts about one.
   *
   * Overrides {@link SparkProps.severity} for the buckets it answers for. It exists because a
   * frames meter has to say *which* of these bars lost frames and which of those had syncmesh on
   * the thread — three different claims in one run, and a single colour for the whole series
   * would have to pick one of them and drop the other two.
   */
  readonly severityOf?: (value: number, at: number) => Severity | undefined;
  /** What one bucket spans, for the label under the run — "5s", "1m". */
  readonly every?: string;
}

const peak = (values: readonly number[]): number => Math.max(1, ...values);

/**
 * A run of buckets as bars.
 *
 * Bars rather than a line, because these series are **counts in a window** and a line between two
 * counts implies values in between that were never measured. A gap in a bar chart reads as "none
 * here"; a gap in a line reads as a slope through nothing.
 */
export function Spark({ values, max, height = 28, severity, severityOf, every }: SparkProps) {
  const top = max ?? peak(values);
  const tint = (value: number, at: number): string => {
    const its = severityOf?.(value, at) ?? severity;
    return its === undefined ? COLOR.neutralFill : SEVERITY_COLOR[its];
  };
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div
        aria-hidden
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          height,
          background: COLOR.track,
          borderRadius: RADIUS.pill,
          overflow: "hidden",
          padding: 1,
        }}
      >
        {values.map((value, at) => (
          <div
            /* eslint-disable-next-line react/no-array-index-key -- a bucket's identity IS its position in the window; two buckets with the same count are the same bar */
            key={at}
            style={{
              flex: 1,
              minWidth: 1,
              // a bucket that happened at all keeps a sliver, so "one event" and "none" differ
              height: value === 0 ? 0 : `${Math.max((value / top) * 100, 6)}%`,
              background: tint(value, at),
              borderRadius: 1,
            }}
          />
        ))}
      </div>
      {every === undefined ? undefined : (
        <div style={{ ...TEXT.micro, color: COLOR.textFaint }}>
          {`${String(values.length)} buckets · ${every} each`}
        </div>
      )}
    </div>
  );
}

export interface Slice {
  readonly label: string;
  readonly value: number;
  readonly severity?: Severity;
}

export interface MixProps {
  readonly slices: readonly Slice[];
  readonly height?: number;
  /** Draw the labels and counts beneath; off where the bar sits inside a dense row. */
  readonly legend?: boolean;
}

/**
 * One bar, divided by share — the ratio answer.
 *
 * A stack rather than a ring because these mixes have four or five parts with names, and a ring
 * with five labelled arcs is a pie chart wearing a disguise. `Ring` stays for the single
 * proportion it is good at: one number, out of one whole, big enough to read across a desk.
 *
 * A slice worth less than a pixel is still given one. Dropping it would make "two refusals in the
 * last minute" look exactly like "none", and the two refusals are the reason anyone opened this.
 */
export function Mix({ slices, height = 6, legend = true }: MixProps) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        style={{
          display: "flex",
          gap: 1,
          height,
          background: COLOR.track,
          borderRadius: RADIUS.pill,
          overflow: "hidden",
        }}
      >
        {total === 0
          ? undefined
          : slices
              .filter((slice) => slice.value > 0)
              .map((slice) => (
                <div
                  key={slice.label}
                  style={{
                    width: `${Math.max((slice.value / total) * 100, 1)}%`,
                    background:
                      slice.severity === undefined
                        ? COLOR.neutralFill
                        : SEVERITY_COLOR[slice.severity],
                  }}
                  title={`${slice.label}: ${String(slice.value)}`}
                />
              ))}
      </div>
      {!legend || total === 0 ? undefined : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {slices
            .filter((slice) => slice.value > 0)
            .map((slice) => (
              <span
                key={slice.label}
                style={{ display: "flex", alignItems: "center", gap: 5, ...TEXT.micro }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: RADIUS.pill,
                    background:
                      slice.severity === undefined
                        ? COLOR.neutralFill
                        : SEVERITY_COLOR[slice.severity],
                  }}
                />
                <span style={{ color: COLOR.textDim }}>{slice.label}</span>
                <span style={{ color: COLOR.text, fontVariantNumeric: "tabular-nums" }}>
                  {slice.value}
                </span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
