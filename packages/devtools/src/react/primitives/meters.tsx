import type { Severity } from "../../tokens.js";

import { COLOR, RADIUS, SEVERITY_COLOR, TEXT } from "../../tokens.js";

/**
 * Two ways to draw a proportion, and one rule they share: the track is always visible.
 *
 * A bar with no track tells you how much; a bar with a track tells you how much *of what*, and the
 * second is the only useful sentence when the number beside it is a health score or a share of a
 * budget. Both are drawn thin — 2px for a bar, 2px of stroke for a ring — because the shape here
 * is meant to be read in peripheral vision while the figure does the talking.
 */

const clamped = (value: number, max: number) =>
  Math.min(1, Math.max(0, max === 0 ? 0 : value / max));

export interface RingProps {
  readonly value: number;
  readonly max?: number | undefined;
  /** Drawn large in the middle. Pass the formatted figure — `65%`, `27`, `1.4k` — not the raw number. */
  readonly display?: string | undefined;
  /** The uppercase caption under it. */
  readonly label?: string | undefined;
  readonly severity?: Severity | undefined;
  readonly size?: number | undefined;
  readonly thickness?: number | undefined;
}

export function Ring({
  value,
  max = 100,
  display,
  label,
  severity,
  size = 108,
  thickness = 2,
}: RingProps) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * clamped(value, max);
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg height={size} style={{ display: "block", transform: "rotate(-90deg)" }} width={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={COLOR.track}
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={severity === undefined ? COLOR.neutralFill : SEVERITY_COLOR[severity]}
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
          strokeWidth={thickness}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeContent: "center",
          justifyItems: "center",
          gap: 2,
        }}
      >
        <div style={{ ...TEXT.numeral, color: COLOR.text }}>{display ?? String(value)}</div>
        {label === undefined ? null : (
          <div style={{ ...TEXT.micro, color: COLOR.textFaint }}>{label}</div>
        )}
      </div>
    </div>
  );
}

export interface MeterProps {
  readonly value: number;
  readonly max?: number | undefined;
  readonly severity?: Severity | undefined;
  /** 2px reads as a rule rather than a widget; 4 is for the one meter a view is actually about. */
  readonly height?: number | undefined;
}

export function Meter({ value, max = 100, severity, height = 2 }: MeterProps) {
  return (
    <div
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={value}
      role="meter"
      style={{
        position: "relative",
        flex: 1,
        minWidth: 24,
        height,
        borderRadius: RADIUS.pill,
        background: COLOR.track,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: `0 auto 0 0`,
          width: `${clamped(value, max) * 100}%`,
          borderRadius: RADIUS.pill,
          background: severity === undefined ? COLOR.neutralFill : SEVERITY_COLOR[severity],
        }}
      />
    </div>
  );
}
