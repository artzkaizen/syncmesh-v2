import { useEffect, useRef, useState } from "react";

import type { LongFrameEntry, LongFrameWatch } from "../dom.js";
import type { FrameBlame, FrameReading } from "../frames.js";
import type { Severity } from "../tokens.js";

import { framesOf, watchLongFrames } from "../dom.js";
import { BUCKET_MS, createFrames } from "../frames.js";
import { COLOR, SEVERITY_COLOR, SPACE, TEXT } from "../tokens.js";
import { Spark } from "./primitives/charts.js";

/**
 * The frames meter: always on while the panel is open, and the one element here that has to
 * survive its own measurement.
 *
 * **What it costs, stated because it must be small.** One `requestAnimationFrame` callback per
 * painted frame, doing two additions and a comparison against a number already in a closure — no
 * allocation, no React, no mesh read. One `setState` every {@link BUCKET_MS}, which is four
 * renders a second of one 120px component. Sixty renders a second to display a number *about*
 * rendering cost would be self-defeating, so the sample rate and the repaint rate are deliberately
 * different things; the repaint period equals the bucket period, so each render draws exactly one
 * new bar and never redraws a bar that has not changed.
 *
 * **What the attribution can and cannot prove.** The preferred source is the Long Animation Frames
 * API, which reports each long frame with a per-script `sourceURL` and `sourceFunctionName`. A bar
 * goes red when a bucket lost frames **and** a script from a syncmesh module ran in the long frame
 * that overlapped it. That is a name match, and it proves a fold was on the main thread while
 * frames were being lost — it does not prove the fold was the only thing there, or that it alone
 * caused the drop. A minified production bundle whose URLs no longer name the package will not
 * match, and then the bar is amber and says *unattributed*, which is the truth rather than a
 * cleared syncmesh. Where the browser offers only `longtask` there is no script attribution at
 * all, and every dropped bucket stays amber for the same reason.
 */

/**
 * The package scope as a module specifier — `@syncmesh/engine`, or Vite's `@syncmesh_engine`.
 *
 * The scope and not the bare word: this repository's own dev server serves every file from a path
 * containing `syncmesh`, so matching the word would blame the mesh for the demo page's own work.
 */
const MESH_URL = /@syncmesh[/\\_]/i;

/**
 * The engine's emitters by name, which is what does the work inside a monorepo where no URL
 * carries the scope. A minified bundle has neither, and the bucket then reads *unattributed* —
 * which is the honest answer and not a cleared syncmesh.
 */
const MESH_FUNCTIONS = new Set(["fold", "foldBatch", "onFoldBatch", "emitFoldBatch"]);

const blameOf = (entry: LongFrameEntry): FrameBlame => {
  const scripts = entry.scripts;
  if (scripts === undefined || scripts.length === 0) return "unattributed";
  const mesh = scripts.some(
    (script) =>
      MESH_URL.test(script.sourceURL ?? "") || MESH_FUNCTIONS.has(script.sourceFunctionName ?? ""),
  );
  return mesh ? "mesh" : "app";
};

/**
 * A bucket's colour, in the vocabulary the rest of the panel already speaks.
 *
 * `critical` is the finding — frames lost with syncmesh on the thread — for the same reason a
 * refused link is the loud colour in the Transports feed: it is the thing somebody opened this to
 * look for, not a judgement that the app is broken. `high` is *frames were lost and this is not
 * ours, or cannot be told*. A bucket that dropped nothing takes no colour at all.
 */
const BLAME_SEVERITY = {
  none: undefined,
  unattributed: "high",
  app: "high",
  mesh: "critical",
} satisfies Record<FrameBlame, Severity | undefined>;

/**
 * One sampler, one paint-clock subscription, one long-frame observer — for the whole panel.
 *
 * The reading is held in a ref and copied into state on a timer rather than set per frame, which
 * is the whole point; see the note above. `undefined` where the runtime does not paint, so a
 * caller renders nothing rather than a zero.
 */
export function useFrames(): FramesProps {
  const held = useRef(createFrames());
  const [seen, setSeen] = useState<FramesProps>({ reading: undefined });
  useEffect(() => {
    const pump = framesOf();
    if (pump === undefined) return;
    const frames = held.current;
    let handle = pump.request(function paint(atMs: number) {
      frames.frame(atMs);
      handle = pump.request(paint);
    });
    const watch = watchLongFrames((entries) => {
      for (const entry of entries) frames.blocked(entry.startTime, entry.duration, blameOf(entry));
    });
    const attribution = watch?.kind;
    // the wall clock is the wrong one: `rAF` stamps milliseconds since navigation, and a tab that
    // has stopped painting is found by comparing two readings of the *same* clock
    const show = (): void =>
      setSeen({ reading: frames.read(now()), ...(attribution !== undefined && { attribution }) });
    const timer = setInterval(show, BUCKET_MS);
    show();
    return () => {
      pump.cancel(handle);
      watch?.disconnect();
      clearInterval(timer);
    };
  }, []);
  return seen;
}

/** The same clock `requestAnimationFrame` stamps its callbacks with; `Date.now` is a different one. */
const now = (): number =>
  // SAFETY: `performance` is a global in every runtime that has `requestAnimationFrame`, and this
  // is only ever reached from inside the effect that found one.
  (globalThis as { performance?: { now: () => number } }).performance?.now() ?? 0;

const sentence = (reading: FrameReading, kind: string): string => {
  if (!reading.measuring)
    return "Not measuring: this tab is not painting. A backgrounded tab gets no animation frames at all, and a tab whose timers have been clamped can look alive while painting nothing.";
  const screen =
    reading.hz === undefined ? "still deriving this display's rate" : `${reading.hz}Hz display`;
  const lost =
    reading.dropped === 0
      ? "no frames lost in the last 8s"
      : `${reading.dropped} frames lost in the last 8s${reading.meshBlamed ? ", some with a syncmesh script on the main thread" : ""}`;
  return `${screen} · ${lost} · ${kind}`;
};

/** What the attribution is worth, said in the tooltip rather than assumed by the colours. */
const SOURCE = {
  "long-animation-frame": "long frames are attributed by script, so a red bar names syncmesh",
  longtask:
    "this browser reports long tasks without script attribution, so no bar can name syncmesh",
} satisfies Record<LongFrameWatch["kind"], string>;

export interface FramesProps {
  readonly reading: FrameReading | undefined;
  /** Which API is behind the colours; absent where the browser offers neither. */
  readonly attribution?: LongFrameWatch["kind"] | undefined;
}

/**
 * The meter as it sits in the strip: a run of bars, then the figure.
 *
 * Bars rather than a figure alone because a spike that has passed is invisible in a number — and
 * the spike is the finding. Bars rather than a line for {@link Spark}'s own reason: a line between
 * two frame counts implies frames in between that were never measured.
 */
export function Frames({ reading, attribution }: FramesProps) {
  if (reading === undefined) return null;
  const kind =
    attribution === undefined
      ? "no long-frame API here, so nothing can be attributed"
      : SOURCE[attribution];
  const severity = reading.meshBlamed ? "critical" : reading.dropped > 0 ? "high" : undefined;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flex: "none" }}
      title={sentence(reading, kind)}
    >
      <div style={{ width: 92 }}>
        <Spark
          height={14}
          severityOf={(_, at) => BLAME_SEVERITY[reading.buckets[at]?.blame ?? "none"]}
          values={reading.buckets.map((bucket) => bucket.frames)}
        />
      </div>
      <span
        style={{
          ...TEXT.xs,
          color: reading.measuring ? COLOR.text : COLOR.textFaint,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {reading.measuring && reading.fps !== undefined ? (
          <>
            {reading.fps}
            <span
              style={{ color: severity === undefined ? COLOR.textFaint : SEVERITY_COLOR[severity] }}
            >
              {" fps"}
            </span>
          </>
        ) : (
          /*
           * A missing figure, in the shape of a figure — never a sentence.
           *
           * "not measuring" sitting bare in the strip reads as a status line for whichever panel
           * is under it, and it was: a reader met it above the storage counts and took it to mean
           * the database was not being read. A meter that has nothing to show says so the way
           * every other meter does, with a dash where the number goes, and puts the explanation
           * in the tooltip that is already there.
           */
          <>
            {"\u2014"}
            <span style={{ color: COLOR.textFaint }}>{" fps"}</span>
          </>
        )}
      </span>
    </div>
  );
}
