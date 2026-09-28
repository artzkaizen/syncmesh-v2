import type { CSSProperties } from "react";

import { COLOR, RADIUS, SEVERITY_COLOR, SPACE, TEXT } from "@syncmesh/devtools/react";
import { Temporal } from "@syncmesh/temporal";

import type { IssueStatus } from "../domain.js";

import { PRIORITY_NAME } from "../domain.js";
import { instantOf } from "../time.js";

/**
 * The app's surface, borrowed from the inspector rather than invented beside it.
 *
 * `@syncmesh/devtools` already publishes a palette and a type scale that were argued over — near
 * black, hairline borders at 7% white, four accents and nothing else coloured — and the panel is
 * going to be open on top of this app half the time it is being looked at. A second dark theme,
 * two shades off, would read as two products stitched together; importing the first one means the
 * inspector docks into the page and the seam disappears. So there are no colour literals below
 * this file except the ones the *data* carries — a team's colour, a label's colour, a person's
 * avatar — which are the workspace's and not the chrome's.
 */

export {
  COLOR,
  FONT,
  RADIUS,
  SEVERITY_COLOR,
  SEVERITY_TINT,
  SPACE,
  TEXT,
} from "@syncmesh/devtools/react";

/** A row height that fits a title, a badge strip and nothing else — Linear's density, near enough. */
export const ROW_HEIGHT = 38;

/** The sidebar is narrow on purpose: it is a set of filters, not a second navigation. */
export const SIDEBAR_WIDTH = 232;

/** The detail panel wants prose width, and the list wants whatever is left. */
export const DETAIL_WIDTH = 420;

/** One border, everywhere. Written once so no view invents a slightly different one. */
export const HAIRLINE = `1px solid ${COLOR.hairline}`;

export const PANE = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
} satisfies CSSProperties;

/** The caption above a number or a group. Uppercase, wide, half-lit — the inspector's `micro`. */
export const CAPTION = { ...TEXT.micro, color: COLOR.textDim } satisfies CSSProperties;

/** Every clickable thing that is not a row: a filter, a sort, a tab. */
export const BUTTON = {
  appearance: "none",
  background: "transparent",
  border: HAIRLINE,
  borderRadius: RADIUS.sm,
  color: COLOR.textDim,
  cursor: "pointer",
  font: "inherit",
  ...TEXT.sm,
  padding: `${String(SPACE.xs)}px ${String(SPACE.sm)}px`,
} satisfies CSSProperties;

export const INPUT = {
  appearance: "none",
  background: COLOR.sunken,
  border: HAIRLINE,
  borderRadius: RADIUS.sm,
  color: COLOR.text,
  font: "inherit",
  ...TEXT.sm,
  padding: `${String(SPACE.xs)}px ${String(SPACE.sm)}px`,
  width: "100%",
} satisfies CSSProperties;

/**
 * Status, as a word and a colour.
 *
 * The colours are the inspector's severity accents put to a different use, which is the one place
 * that vocabulary is stretched: `started` is not an emergency, it is in flight. They are borrowed
 * anyway because six new hues would be six more saturated pixels competing with the four that
 * mean something, and a board where every column shouts is a board where none of them does.
 */
export interface StatusStyle {
  readonly label: string;
  readonly color: string;
}

export const STATUS_STYLE = {
  triage: { label: "Triage", color: COLOR.textDim },
  backlog: { label: "Backlog", color: COLOR.textFaint },
  todo: { label: "Todo", color: COLOR.neutralFill },
  started: { label: "In progress", color: SEVERITY_COLOR.high },
  done: { label: "Done", color: SEVERITY_COLOR.ok },
  canceled: { label: "Canceled", color: COLOR.textFaint },
} satisfies Record<IssueStatus, StatusStyle>;

/**
 * The same table, reached by a plain string.
 *
 * Drizzle types a `text` column as `string`, so a row's `status` arrives unnarrowed however
 * emphatically the manifest checks it — and the honest way across that gap is a total lookup with
 * a visible fallback, not an assertion that the six words are all there ever will be. A seventh
 * status shipped by a newer peer then renders as itself instead of crashing the list.
 */
const STYLES = new Map<string, StatusStyle>(Object.entries(STATUS_STYLE));
const UNKNOWN = { label: "Unknown", color: COLOR.textFaint } satisfies StatusStyle;

export const statusStyle = (status: string): StatusStyle => STYLES.get(status) ?? UNKNOWN;

/** `0 none … 4 urgent`, as a person reads it. The numbers sort; the names are for the eye. */
export const priorityName = (priority: number): string =>
  PRIORITY_NAME[priority] ?? PRIORITY_NAME[0];

/**
 * How long ago, in the four units anyone reads at a glance.
 *
 * `Temporal.Duration.total` rather than arithmetic on milliseconds, because a bare number of
 * milliseconds is exactly the thing this codebase does not carry — and because the rounding a
 * person expects ("7d", not "6.8d") is a property of the unit, which a duration knows and a
 * number does not.
 */
export function ago(when: Date, now: Temporal.Instant = Temporal.Now.instant()): string {
  const elapsed = now.since(instantOf(when));
  const minutes = Math.round(elapsed.total("minutes"));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(elapsed.total("hours"));
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.round(elapsed.total("days"));
  return days < 30 ? `${String(days)}d` : `${String(Math.round(days / 30))}mo`;
}

/** A person's initials, for an avatar that is a circle of colour and two letters. */
export const initials = (name: string): string =>
  name
    .split(" ")
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
