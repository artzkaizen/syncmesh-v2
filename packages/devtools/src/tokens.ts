/**
 * The palette, the scale, and the four accents — as plain constants, not CSS custom properties.
 *
 * Custom properties inherit, and inheritance is the one thing a devtool cannot afford: a host page
 * that defines `--color-critical` for its own reasons would repaint ours from outside. These names
 * resolve at build time into one stylesheet and a handful of inline `style` objects, which puts
 * them out of the page's reach entirely.
 *
 * Almost nothing here is coloured. The near-black surfaces and the hairline borders exist so that
 * the severity accents are the only saturated pixels on screen — when everything can shout,
 * nothing is urgent. A fifth accent makes the other four quieter, so there are four.
 */

/** How a panel rates a thing, and the only vocabulary it has for doing so. */
export type Severity = "critical" | "high" | "medium" | "low" | "info" | "ok" | "muted";

export const COLOR = {
  /** Darker than any app chrome, so the panel never reads as part of the page it is sitting on. */
  surface: "#0a0a0a",
  /** One step up: the active sidebar row, and the wells that hold a url or a trio of stats. */
  raised: "#141414",
  /** One step down: a table header strip, an input, anything recessed into the surface. */
  sunken: "#050505",
  /** 1px at 7% is a border you can see and cannot feel. Two of them meeting still reads as one. */
  hairline: "rgba(255, 255, 255, 0.07)",
  /** For the one border per view that has to be found by eye — a dock edge, a focused input. */
  hairlineStrong: "rgba(255, 255, 255, 0.14)",
  /** The `+` where gridlines cross, brighter than the lines: it is punctuation, not structure. */
  crosshair: "rgba(255, 255, 255, 0.22)",
  text: "#ededed",
  textDim: "#8b8b8b",
  textFaint: "#5a5a5a",
  /** Meters and rings carrying no severity are bright grey, never white — white is for numerals. */
  neutralFill: "#cfcfcf",
  /** What a meter or ring is drawn on: present enough to show the empty part, dim enough to ignore. */
  track: "rgba(255, 255, 255, 0.09)",
  focus: "rgba(255, 255, 255, 0.5)",
  /** A row under the pointer. Fills, never borders: a border that appears on hover moves the text. */
  hover: "rgba(255, 255, 255, 0.04)",
};

export const SEVERITY_COLOR = {
  critical: "#ef4a5a",
  high: "#f5a524",
  medium: "#37c26a",
  low: "#3b82f6",
  info: "#3b82f6",
  ok: "#37c26a",
  muted: "#6b6b6b",
} satisfies Record<Severity, string>;

/**
 * The same accents at the opacity a tag's fill needs. Alpha rather than a mixed hex, because these
 * sit on three different surfaces and a pre-mixed tint would be wrong on two of them.
 */
export const SEVERITY_TINT = {
  critical: "rgba(239, 74, 90, 0.13)",
  high: "rgba(245, 165, 36, 0.13)",
  medium: "rgba(55, 194, 106, 0.13)",
  low: "rgba(59, 130, 246, 0.13)",
  info: "rgba(59, 130, 246, 0.13)",
  ok: "rgba(55, 194, 106, 0.13)",
  muted: "rgba(255, 255, 255, 0.06)",
} satisfies Record<Severity, string>;

/** A 4px grid. Everything that is not a hairline is a multiple of it, which is why the density reads as deliberate. */
export const SPACE = { px: 1, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const RADIUS = { sm: 4, md: 6, lg: 10, pill: 999 };

export const FONT = {
  sans: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /** Ids, hashes and payloads, where a column of characters has to line up to be scannable. */
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

/**
 * Five sizes, and `as const` so each one stays assignable to `CSSProperties` rather than widening
 * `textTransform` to `string`.
 */
export const TEXT = {
  /** Uppercase, wide-tracked, half-lit: the caption above a numeral. Never used for prose. */
  micro: {
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: "0.11em",
    textTransform: "uppercase",
    lineHeight: 1.4,
  },
  xs: { fontSize: 11, lineHeight: 1.45 },
  sm: { fontSize: 12, lineHeight: 1.5 },
  md: { fontSize: 13, lineHeight: 1.5 },
  /** Large and light: a number that is also bold is a number shouting about its own size. */
  numeral: {
    fontSize: 26,
    fontWeight: 300,
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
    fontVariantNumeric: "tabular-nums",
  },
} as const;

/**
 * Above everything, because a host page with a full-screen modal at 999999 still has to lose. One
 * below the signed 32-bit ceiling leaves a rung for anything that genuinely must sit on top of us.
 */
export const Z_LAYER = 2_147_483_646;
