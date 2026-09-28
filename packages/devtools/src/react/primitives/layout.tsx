import type { CSSProperties, ReactNode } from "react";

import type { Severity } from "../../tokens.js";

import { PREFIX } from "../../css.js";
import { COLOR, SPACE, TEXT } from "../../tokens.js";
import { StatusDot } from "./stat.js";

/**
 * The frame, the dense row, and the nothing-here state.
 *
 * The `+` marks at the corners are the one ornament in this design, and they earn their place by
 * being a lie told honestly: they imply a gridline continuing past the panel, which makes a box
 * read as a crop of a larger drawing rather than a card floating on a background. They are drawn
 * brighter than the hairlines they mark, because a crossing you cannot see is just a smudge.
 */

const CORNERS = [
  { top: -5, left: -5 },
  { top: -5, right: -5 },
  { bottom: -5, left: -5 },
  { bottom: -5, right: -5 },
] satisfies CSSProperties[];

export interface CrossProps {
  /** Absolute placement inside the nearest positioned ancestor, centred on the crossing itself. */
  readonly at: CSSProperties;
}

/** One mark. Pointer-transparent, so it never steals a click from the frame it decorates. */
export function Cross({ at }: CrossProps) {
  return <span className={`${PREFIX}-cross`} style={at} />;
}

/** The four corners of a frame, which is where its gridlines would have crossed. */
export function Crosshairs() {
  return (
    <>
      {CORNERS.map((at, index) => (
        <Cross at={at} key={index} />
      ))}
    </>
  );
}

export interface PanelProps {
  readonly title?: string | undefined;
  /** One clause, set dim beside the title — what the panel is for, not what it contains. */
  readonly subtitle?: string | undefined;
  /** Top-right: a "View all", a toolbar, a count. */
  readonly actions?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
  /** Off for a panel that fills the body, where a frame would only double the shell's own border. */
  readonly bordered?: boolean | undefined;
  readonly padded?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  bordered = true,
  padded = true,
  style,
}: PanelProps) {
  return (
    <section
      style={{
        position: "relative",
        border: bordered ? `1px solid ${COLOR.hairline}` : undefined,
        background: COLOR.surface,
        minWidth: 0,
        ...style,
      }}
    >
      {bordered ? <Crosshairs /> : null}
      {title === undefined && actions === undefined ? null : (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: SPACE.md,
            padding: `${SPACE.md}px ${SPACE.lg}px`,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: SPACE.sm, minWidth: 0 }}>
            <h2 style={{ ...TEXT.md, margin: 0, fontWeight: 400, color: COLOR.text }}>{title}</h2>
            {subtitle === undefined ? null : (
              <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>&middot; {subtitle}</span>
            )}
          </div>
          {actions}
        </header>
      )}
      <div style={{ padding: padded ? `0 ${SPACE.lg}px ${SPACE.lg}px` : undefined, minWidth: 0 }}>
        {children}
      </div>
    </section>
  );
}

export interface RowProps {
  /** Colours the leading dot. Omitted, the row has no dot and sits flush with the ones that do. */
  readonly severity?: Severity | undefined;
  readonly label: ReactNode;
  /** A second, dimmer line — the peer, the timestamp, the table this row came from. */
  readonly meta?: ReactNode | undefined;
  /** The middle: a {@link Meter}, a tag strip, anything that should absorb the spare width. */
  readonly children?: ReactNode | undefined;
  /** Right-aligned figure or verdict. */
  readonly trailing?: ReactNode | undefined;
  /** Revealed on hover and on keyboard focus — never on both sides of a row at once. */
  readonly action?: ReactNode | undefined;
}

export function Row({ severity, label, meta, children, trailing, action }: RowProps) {
  return (
    <div
      className={`${PREFIX}-row`}
      style={{
        gap: SPACE.md,
        padding: `${SPACE.sm}px ${SPACE.md}px`,
        borderBottom: `1px solid ${COLOR.hairline}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0, flex: 1 }}>
        {severity === undefined ? null : <StatusDot severity={severity} />}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              ...TEXT.sm,
              color: COLOR.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
          {meta === undefined ? null : (
            <div style={{ ...TEXT.xs, color: COLOR.textFaint }}>{meta}</div>
          )}
        </div>
      </div>
      {children === undefined ? null : (
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 40 }}>
          {children}
        </div>
      )}
      {trailing === undefined ? null : (
        <div style={{ ...TEXT.sm, color: COLOR.textDim, flex: "none" }}>{trailing}</div>
      )}
      {action === undefined ? null : <div style={{ flex: "none" }}>{action}</div>}
    </div>
  );
}

export interface EmptyProps {
  readonly icon?: ReactNode | undefined;
  readonly title: string;
  /** What to do about it. An empty panel with no next step is a panel that looks broken. */
  readonly hint?: string | undefined;
}

export function Empty({ icon, title, hint }: EmptyProps) {
  return (
    <div
      style={{
        display: "grid",
        justifyItems: "center",
        gap: SPACE.sm,
        padding: `${SPACE.xxl}px ${SPACE.lg}px`,
        color: COLOR.textFaint,
        textAlign: "center",
      }}
    >
      {icon}
      <div style={{ ...TEXT.sm, color: COLOR.textDim }}>{title}</div>
      {hint === undefined ? null : <div style={{ ...TEXT.xs, maxWidth: 320 }}>{hint}</div>}
    </div>
  );
}
