import type { CSSProperties, MouseEvent } from "react";

import type { Corner } from "../state.js";

import { PREFIX } from "../css.js";
import { COLOR, RADIUS, SEVERITY_COLOR, SPACE } from "../tokens.js";
import { Icon } from "./icons.js";

/**
 * The closed state: one button, one glyph, and deliberately almost no information.
 *
 * A badge here — peers connected, events pending, a red dot when something is wrong — would be the
 * nicest feature in the package and would also mean subscribing to the mesh for every app that has
 * ever installed the devtools and left them shut. The bubble is mute so that closed really is
 * free. What it costs is a click to find out, and that is the right trade.
 *
 * **One exception, and it is the exception that proves the rule.** A medium the inspector is
 * holding off gets a mark, because that state was created by a person clicking in this panel and
 * the person who has to find it again is the one who forgot. It costs nothing where the rule
 * applies: an app that passed no controls has nothing to subscribe to, so a shut inspector in a
 * production build is a button and a keydown listener exactly as before. Nothing here reads the
 * mesh — `forced` arrives as a number the caller already had.
 *
 * The mark is drawn twice over, as a dot and as a warmer ring, and the button carries
 * `data-forced` so a host stylesheet or a browser check can find it without counting spans.
 */

/** Far enough from the edge to clear a scrollbar and a browser's own corner affordances. */
const INSET = SPACE.lg;

const place = (corner: Corner): CSSProperties => ({
  top: corner.startsWith("top") ? INSET : undefined,
  bottom: corner.startsWith("bottom") ? INSET : undefined,
  left: corner.endsWith("left") ? INSET : undefined,
  right: corner.endsWith("right") ? INSET : undefined,
});

export interface BubbleProps {
  readonly corner: Corner;
  /** The tooltip — what this is, and the shortcut, because a shortcut nobody is told is not one. */
  readonly hint: string;
  readonly onOpen: () => void;
  /**
   * Alt-click, or a right-click: move to the next corner. Hidden on purpose — the bubble is in the
   * way roughly once a year, and a visible drag handle on a 34px button is a button you misclick.
   */
  readonly onMove: () => void;
  /** How many mediums the inspector is holding off. `0` on every app that passed no controls. */
  readonly forced?: number | undefined;
}

export function Bubble({ corner, hint, onOpen, onMove, forced = 0 }: BubbleProps) {
  const move = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onMove();
  };
  return (
    <button
      aria-label={hint}
      className={`${PREFIX}-bubble`}
      data-forced={forced > 0 ? "true" : undefined}
      onClick={(event) => (event.altKey ? move(event) : onOpen())}
      onContextMenu={move}
      style={{
        ...place(corner),
        position: "fixed",
        width: 34,
        height: 34,
        pointerEvents: "auto",
      }}
      title={hint}
      type="button"
    >
      <Icon name="mesh" size={17} strokeWidth={1.3} />
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 3,
          borderRadius: 7,
          border: `1px solid ${forced > 0 ? `${SEVERITY_COLOR.high}66` : COLOR.hairline}`,
          pointerEvents: "none",
        }}
      />
      {forced > 0 ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -3,
            right: -3,
            width: 9,
            height: 9,
            borderRadius: RADIUS.pill,
            background: SEVERITY_COLOR.high,
            border: `2px solid ${COLOR.surface}`,
          }}
        />
      ) : null}
    </button>
  );
}
