import type { IssueStatus } from "@syncmesh/issues";

import { memo } from "react";
import { View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { sawSubtreeRender } from "./nav-timing";

/**
 * The two glyphs a tracker is read by: what state an issue is in, and how much it matters.
 *
 * **Drawn rather than lettered, because a list is scanned and not read.** The word "started" and
 * the word "backlog" are the same grey smudge at arm's length; a half-filled ring and a dotted ring
 * are not. This is the single biggest reason Linear's list is legible at a glance and a list of
 * status chips is not — the chips were the same width, the same colour, and carried the one piece
 * of information the eye could not use.
 *
 * Both are pure SVG at a fixed box so a row's height never depends on them, and both are `memo`'d
 * because a recycling list re-renders rows on every scroll frame.
 */

/** The palette these glyphs use, which is the status colour and nothing else in the app. */
export const STATUS_COLOR = {
  triage: "#e5484d",
  backlog: "#8a8f98",
  todo: "#8a8f98",
  started: "#f2c94c",
  done: "#5e6ad2",
  canceled: "#6b7080",
} as const satisfies Record<IssueStatus, string>;

const BOX = 16;
const R = 6.5;
const CENTRE = BOX / 2;

/**
 * An issue's state as a ring, filled by how far along it is.
 *
 * The progression is the information: an empty ring is untouched, a dashed ring is parked, a
 * quarter-filled ring is moving, a solid tick is finished. A person learns it once and then never
 * reads a status word again, which is the point.
 */
export const StatusGlyph = memo(function StatusGlyph({
  size = BOX,
  status,
}: {
  readonly size?: number;
  readonly status: string;
}) {
  sawSubtreeRender();
  const color = STATUS_COLOR[status as IssueStatus] ?? STATUS_COLOR.backlog;
  return (
    <Svg height={size} viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} width={size}>
      {status === "done" ? (
        <>
          <Circle cx={CENTRE} cy={CENTRE} fill={color} r={R + 1} />
          <Path
            d="M4.6 8.2 L7 10.6 L11.4 5.6"
            stroke="#fff"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
          />
        </>
      ) : status === "canceled" ? (
        <>
          <Circle cx={CENTRE} cy={CENTRE} fill={color} r={R + 1} />
          <Path
            d="M5.4 5.4 L10.6 10.6 M10.6 5.4 L5.4 10.6"
            stroke="#fff"
            strokeLinecap="round"
            strokeWidth={1.8}
          />
        </>
      ) : (
        <>
          <Circle
            cx={CENTRE}
            cy={CENTRE}
            fill="none"
            r={R}
            stroke={color}
            // a dashed ring reads as "parked" without needing a second colour
            strokeDasharray={status === "backlog" ? "2.2 2.2" : undefined}
            strokeWidth={1.6}
          />
          {/* the pie wedge: nothing for todo, a quarter for triage, a half for started */}
          {status === "started" ? (
            <Path
              d={`M${String(CENTRE)} ${String(CENTRE)} L${String(CENTRE)} ${String(CENTRE - 3.6)} A3.6 3.6 0 0 1 ${String(CENTRE)} ${String(CENTRE + 3.6)} Z`}
              fill={color}
            />
          ) : null}
          {status === "triage" ? <Circle cx={CENTRE} cy={CENTRE} fill={color} r={2.2} /> : null}
        </>
      )}
    </Svg>
  );
});

/** The colour urgency is drawn in — only `urgent` earns one, so the eye finds it immediately. */
const PRIORITY_COLOR = ["#6b7080", "#8a8f98", "#8a8f98", "#8a8f98", "#e5484d"] as const;

/**
 * Priority as three ascending bars, the way a signal-strength meter reads.
 *
 * `none` is three flat dashes rather than an empty space, because "nobody has said" and "this
 * failed to load" must not look the same. `urgent` is the one that gets a colour.
 */
export const PriorityGlyph = memo(function PriorityGlyph({
  priority,
  size = BOX,
}: {
  readonly priority: number;
  readonly size?: number;
}) {
  sawSubtreeRender();
  const level = Math.max(0, Math.min(4, Math.round(priority)));
  const color = PRIORITY_COLOR[level] ?? PRIORITY_COLOR[0];
  if (level === 0)
    return (
      <Svg height={size} viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} width={size}>
        <Rect fill={color} height={1.6} opacity={0.5} rx={0.8} width={9} x={3.5} y={7.2} />
      </Svg>
    );
  // urgent is not a taller bar but a filled block: it has to break the pattern to be seen
  if (level === 4)
    return (
      <Svg height={size} viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} width={size}>
        <Rect fill={color} height={11} rx={2} width={11} x={2.5} y={2.5} />
        <Rect fill="#fff" height={4.4} rx={0.7} width={1.5} x={7.25} y={4.4} />
        <Rect fill="#fff" height={1.5} rx={0.7} width={1.5} x={7.25} y={10} />
      </Svg>
    );
  return (
    <Svg height={size} viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} width={size}>
      {[0, 1, 2].map((bar) => (
        <Rect
          fill={color}
          height={3.5 + bar * 3}
          key={bar}
          // a bar past the level is drawn faintly rather than omitted, so all three read as a scale
          opacity={bar < level ? 1 : 0.25}
          rx={1}
          width={3}
          x={2.2 + bar * 4}
          y={12 - (3.5 + bar * 3)}
        />
      ))}
    </Svg>
  );
});

/** A person's colour as a disc, for the places a full avatar is too much furniture. */
export const Dot = memo(function Dot({
  color,
  size = 8,
}: {
  readonly color: string;
  readonly size?: number;
}) {
  sawSubtreeRender();
  return (
    <View style={{ backgroundColor: color, borderRadius: size / 2, height: size, width: size }} />
  );
});
