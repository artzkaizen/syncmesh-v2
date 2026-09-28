import type { CSSProperties, ReactNode } from "react";

import type { LabelRow, MemberRow } from "./view.js";

import { COLOR, RADIUS, SPACE, TEXT, initials, priorityName, statusStyle } from "./ui.js";

/**
 * The half-dozen marks this app repeats a few hundred times a screen.
 *
 * Each one is here rather than inline because each one is a *decision* — a status is a ring and
 * not a filled dot, a priority is bars and not a word, an unnumbered issue reads `ENG-•` and not
 * a blank — and a decision made in six places is a decision that will be made differently in the
 * seventh. None of them takes a colour: they read it from the row or from the palette, so nothing
 * below this file picks one.
 */

/**
 * The status ring. Open statuses are an outline, `done` is filled and `canceled` is struck
 * through — so a glance down the column separates "still ours" from "finished with" without
 * reading a single word.
 */
export function StatusMark({ status }: { readonly status: string }) {
  const { color, label } = statusStyle(status);
  const filled = status === "done";
  return (
    <span
      aria-label={label}
      role="img"
      style={{
        background: filled ? color : "transparent",
        border: `1.5px solid ${color}`,
        borderRadius: RADIUS.pill,
        display: "inline-block",
        flex: "none",
        height: 11,
        opacity: status === "canceled" ? 0.45 : 1,
        width: 11,
      }}
    />
  );
}

/**
 * Priority as four rising bars, lit up to the level. A number nobody can read at a glance and a
 * word that costs sixty pixels per row are the two alternatives; this is the one Linear settled
 * on, and it is right — the shape carries the ordering, which a word does not.
 */
export function PriorityMark({ priority }: { readonly priority: number }) {
  return (
    <span
      aria-label={`Priority: ${priorityName(priority)}`}
      role="img"
      style={{ alignItems: "flex-end", display: "inline-flex", flex: "none", gap: 1.5, height: 11 }}
    >
      {[4, 7, 10].map((height, step) => (
        <span
          key={height}
          style={{
            background: step < Math.ceil(priority * 0.75) ? COLOR.neutralFill : COLOR.track,
            borderRadius: 1,
            display: "block",
            height,
            width: 2.5,
          }}
        />
      ))}
    </span>
  );
}

/** A person, as a circle of their own colour. Unassigned is a dashed ring, not an empty gap. */
export function Avatar({
  who,
  size = 18,
}: {
  readonly who: MemberRow | undefined;
  readonly size?: number;
}) {
  const shared = {
    alignItems: "center",
    borderRadius: RADIUS.pill,
    display: "inline-flex",
    flex: "none",
    height: size,
    justifyContent: "center",
    width: size,
  } satisfies CSSProperties;
  if (who === undefined)
    return (
      <span
        aria-label="Unassigned"
        role="img"
        style={{ ...shared, border: `1px dashed ${COLOR.hairlineStrong}` }}
      />
    );
  return (
    <span
      style={{
        ...shared,
        background: who.avatarColor,
        color: "#0a0a0a",
        fontSize: size * 0.42,
        fontWeight: 600,
      }}
      title={who.name}
    >
      {initials(who.name)}
    </span>
  );
}

/** A label, in its own colour at the tint the inspector's tags use — a fill, never a border. */
export function LabelChip({ of }: { readonly of: LabelRow }) {
  return (
    <span
      style={{
        alignItems: "center",
        border: `1px solid ${of.color}44`,
        borderRadius: RADIUS.pill,
        color: of.color,
        display: "inline-flex",
        gap: SPACE.xs,
        ...TEXT.xs,
        flex: "none",
        padding: `0 ${String(SPACE.sm)}px`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ background: of.color, borderRadius: RADIUS.pill, height: 6, width: 6 }} />
      {of.name}
    </span>
  );
}

/**
 * `ENG-42`, or `ENG-•` for an issue no authority has numbered yet.
 *
 * The dot is the point of this component. An issue filed on a train exists, syncs, merges and can
 * be argued about long before a server mints its number, and the honest rendering of that is a
 * placeholder in the column where the number goes — not a blank, which reads as a bug, and not a
 * locally-invented number, which is the one thing a device must never do here.
 */
export function Identifier({
  teamKey,
  number,
}: {
  readonly teamKey: string;
  readonly number: number | null;
}) {
  return (
    <span
      style={{
        color: number === null ? COLOR.textFaint : COLOR.textDim,
        ...TEXT.xs,
        flex: "none",
        fontVariantNumeric: "tabular-nums",
        width: 62,
      }}
      title={number === null ? "waiting on an authority for its number" : undefined}
    >
      {teamKey}-{number === null ? "•" : number}
    </span>
  );
}

/** A labelled block of chrome: the caption, then whatever it introduces. */
export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: SPACE.sm }}>
      <div style={{ ...TEXT.micro, color: COLOR.textFaint }}>{title}</div>
      {children}
    </div>
  );
}
