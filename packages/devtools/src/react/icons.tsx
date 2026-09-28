/**
 * The glyph set, as path data rather than a dependency.
 *
 * An icon package would be the largest thing this devtool adds to an app's bundle, for eleven
 * shapes that never change. They are all one weight on one 24px grid, because the restraint in
 * this design comes from the lines being identical everywhere — a stroke that varies by a quarter
 * pixel between the tab bar and a table row is the thing that makes an interface look assembled.
 */

export type IconName =
  | "mesh"
  | "activity"
  | "database"
  | "radio"
  | "query"
  | "search"
  | "filter"
  | "close"
  | "dock-bottom"
  | "dock-right"
  | "chevron-right"
  | "chevron-down"
  | "open";

const PATHS = {
  mesh: "M12 3v6m0 6v6M4.6 7.5l5.2 3m4.4 2.5l5.2 3M19.4 7.5l-5.2 3m-4.4 2.5l-5.2 3",
  activity: "M3 12h3.5L9 5l4 14 2.6-7H21",
  database:
    "M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5zM4 6.5v11c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-11M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5",
  radio:
    "M12 12h.01M8.5 8.5a5 5 0 000 7m7-7a5 5 0 010 7M5.6 5.6a9 9 0 000 12.8m12.8-12.8a9 9 0 010 12.8",
  query: "M4 5h16M4 12h10M4 19h6m5.5-2.5a3.5 3.5 0 107 0 3.5 3.5 0 00-7 0zm5.9 3l2.6 2.6",
  search: "M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm4.8 11.4L20 20",
  filter: "M4 6h16l-6.2 7.3V19L10.2 20v-6.7z",
  close: "M6 6l12 12M18 6L6 18",
  "dock-bottom": "M4 5h16v14H4zM4 14h16",
  "dock-right": "M4 5h16v14H4zM15 5v14",
  "chevron-right": "M9.5 5.5l6.5 6.5-6.5 6.5",
  "chevron-down": "M5.5 9.5l6.5 6.5 6.5-6.5",
  open: "M8 16L16.5 7.5M9.5 7.5H17v7.5",
} satisfies Record<IconName, string>;

export interface IconProps {
  readonly name: IconName;
  /** 14 in a dense row, 16 in the tab bar, 18 on the bubble. Nothing else looks right at these weights. */
  readonly size?: number | undefined;
  readonly strokeWidth?: number | undefined;
}

export function Icon({ name, size = 16, strokeWidth = 1.4 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      style={{ display: "block", flex: "none" }}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
