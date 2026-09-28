import type { ReactNode } from "react";

import type { Severity } from "../../tokens.js";

import { PREFIX } from "../../css.js";
import { COLOR, RADIUS, SEVERITY_COLOR, SEVERITY_TINT, SPACE, TEXT } from "../../tokens.js";

/**
 * The three smallest pieces, and the ones that carry the whole tone.
 *
 * A number is not a sentence: the caption above it is set small, wide and uppercase so it reads as
 * a label and disappears once you know what the column is, and the numeral itself is large and
 * *light*, because weight on a figure that is already 26px is shouting twice. Figures are tabular
 * everywhere, so a count that ticks from 9 to 10 does not move the panel.
 */

export interface StatusDotProps {
  readonly severity?: Severity | undefined;
  readonly size?: number | undefined;
}

/** Five pixels of colour before a label. The only thing in a dense row allowed to be saturated. */
export function StatusDot({ severity = "muted", size = 5 }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: RADIUS.pill,
        background: SEVERITY_COLOR[severity],
      }}
    />
  );
}

export interface TagProps {
  readonly children: ReactNode;
  /**
   * `outline` is metadata — a table name, an environment, a transport. `solid` is a verdict, and
   * takes the accent; the two never mix in one row, because then neither means anything.
   */
  readonly variant?: "outline" | "solid" | undefined;
  readonly severity?: Severity | undefined;
  readonly mono?: boolean | undefined;
}

export function Tag({ children, variant = "outline", severity = "muted", mono = false }: TagProps) {
  const solid = variant === "solid";
  return (
    <span
      className={`${PREFIX}-tag`}
      style={{
        ...TEXT.xs,
        display: "inline-flex",
        alignItems: "center",
        gap: SPACE.xs,
        padding: "2px 7px",
        borderRadius: RADIUS.sm,
        whiteSpace: "nowrap",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
        color: solid ? SEVERITY_COLOR[severity] : COLOR.textDim,
        background: solid ? SEVERITY_TINT[severity] : "transparent",
        border: `1px solid ${solid ? "transparent" : COLOR.hairline}`,
      }}
    >
      {children}
    </span>
  );
}

export interface StatProps {
  /** Set uppercase and tracked by this component; pass it in ordinary words. */
  readonly label: string;
  readonly value: ReactNode;
  /** A 16px glyph on the top line, opposite the delta. */
  readonly icon?: ReactNode | undefined;
  /** The `+10%` beside the icon — a {@link Tag}, usually solid. */
  readonly delta?: ReactNode | undefined;
  /** Tints the numeral. Left off for anything that is merely a count. */
  readonly severity?: Severity | undefined;
}

export function Stat({ label, value, icon, delta, severity }: StatProps) {
  return (
    <div style={{ padding: `${SPACE.lg}px ${SPACE.lg}px ${SPACE.xl}px`, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 18,
          color: COLOR.textFaint,
        }}
      >
        {icon}
        {delta}
      </div>
      <div style={{ ...TEXT.micro, color: COLOR.textDim, marginTop: SPACE.lg }}>{label}</div>
      <div
        style={{
          ...TEXT.numeral,
          marginTop: SPACE.xs,
          color: severity === undefined ? COLOR.text : SEVERITY_COLOR[severity],
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}
