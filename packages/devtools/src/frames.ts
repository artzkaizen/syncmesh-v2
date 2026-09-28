/**
 * Frames this device actually painted, and which of the lost ones syncmesh was holding the thread
 * for.
 *
 * **Why a sync inspector counts frames at all.** `onFoldBatch` and `onTelemetry` run
 * *synchronously inside the write path*, and every live query re-runs on a fold — so a catch-up
 * that folds a large batch, or one live query re-reading a thousand rows, takes the main thread
 * away from the compositor. A person does not experience that as a slow fold; they experience it
 * as *the app freezes whenever it syncs*. Chrome's own meter can tell you a frame was dropped. It
 * cannot tell you a **fold** dropped it, and that attribution is the whole product here — a bare
 * rate is the part the browser already does better.
 *
 * **Why it can afford a permanent seat when no counter could.** Everything else a header might
 * carry is read on every channel change, `fold` included, and `fold` is synchronous inside the
 * write. This reads nothing from the mesh at all: it is fed timestamps by `requestAnimationFrame`
 * and long-frame records by the browser, so its cost is independent of how busy the mesh is —
 * which is the one property you want from the instrument that measures how busy the mesh is
 * making the main thread.
 *
 * Nothing here touches a browser. The sampler is a state machine fed numbers, so the arithmetic
 * that decides "this bar is red" can be tested without a DOM, a clock or a paint.
 */

/** How long one bar covers. Also the repaint period, so one render draws exactly one new bar. */
export const BUCKET_MS = 250;

/** Eight seconds of run: long enough that a spike is still on screen when you look up at it. */
export const BUCKETS = 32;

/**
 * Longer than this without a painted frame and this tab is not painting.
 *
 * A backgrounded tab gets no `requestAnimationFrame` at all, and a tab whose timers have been
 * clamped can be in the same state while looking alive. Both must read as **not measuring**: a
 * meter that keeps showing its last figure, or shows a plausible `0`, is worse than one that
 * admits it has stopped, because only one of those is a state somebody can act on.
 */
export const STALLED_MS = 1200;

/** Intervals kept for deriving the display's rate: two seconds at 60Hz, one at 120. */
const RATE_SAMPLES = 120;

/** Nothing paints faster than this. Two callbacks inside one vsync are not a 250Hz screen. */
const FASTEST_MS = 4;

/** Below this many intervals the rate is a guess, and a guess must not produce a dropped count. */
const RATE_READY = 8;

/** Frames a second is a second's worth of buckets — the last complete four, not the one in flight. */
const SECOND = Math.round(1000 / BUCKET_MS);

/**
 * What the browser said was on the thread while frames were being lost.
 *
 * `mesh` is the finding this exists to produce and the only one that is a claim about syncmesh;
 * `unattributed` is a bucket that lost frames with nothing to pin them on, which is the honest
 * answer in a browser with no Long Animation Frames API and in a minified bundle whose script
 * URLs no longer name anything.
 */
export type FrameBlame = "none" | "unattributed" | "app" | "mesh";

/** Worse wins when two records land in one bucket; `mesh` outranks `app` because it is the finding. */
const RANK = { none: 0, unattributed: 1, app: 2, mesh: 3 } satisfies Record<FrameBlame, number>;

const worse = (held: FrameBlame, next: FrameBlame): FrameBlame =>
  RANK[next] > RANK[held] ? next : held;

/** One slice of the run: what was painted in it, what was lost, and who was holding the thread. */
export interface FrameBucket {
  readonly frames: number;
  readonly dropped: number;
  readonly blame: FrameBlame;
}

export interface FrameReading {
  /** Oldest first, always {@link BUCKETS} long, so the bars never re-scale under the eye. */
  readonly buckets: readonly FrameBucket[];
  /** Frames in the last complete second; `undefined` while this tab is not painting. */
  readonly fps: number | undefined;
  /**
   * What this display can do, derived rather than assumed.
   *
   * High-refresh screens are ordinary now, so a meter that treats 60 as the target paints a 120Hz
   * display as permanently over budget and a 120Hz display that has fallen to 60 as perfect. The
   * estimator is the **shortest interval seen**, because jank only ever makes an interval longer:
   * the fastest frame this screen managed is the closest thing to its period that can be observed
   * from inside a script.
   */
  readonly hz: number | undefined;
  /** False when nothing has painted for {@link STALLED_MS}. The meter says so rather than guessing. */
  readonly measuring: boolean;
  readonly dropped: number;
  /** Whether any frames lost in the window had a syncmesh script on the thread with them. */
  readonly meshBlamed: boolean;
}

export interface Frames {
  /** One painted frame, at the `requestAnimationFrame` timestamp. */
  readonly frame: (atMs: number) => void;
  /**
   * A long animation frame the browser reported, and what it named. Only buckets that actually
   * lost frames take the blame: a long frame that dropped nothing is not what anybody is looking
   * for, and colouring it would spend the one loud colour on a non-event.
   */
  readonly blocked: (startMs: number, durationMs: number, blame: FrameBlame) => void;
  readonly read: (nowMs: number) => FrameReading;
}

/** {@link FrameBucket} while it is still being filled — the one place these numbers are mutable. */
interface Slot {
  frames: number;
  dropped: number;
  blame: FrameBlame;
}

const blank = (): Slot => ({ frames: 0, dropped: 0, blame: "none" });

/**
 * How many frames the screen could have painted in this interval and did not.
 *
 * Measured against the derived period rather than a constant: a 16.7ms gap is one frame on a 60Hz
 * display and seven on a 120Hz one, and only one of those readings is about this machine.
 */
export const droppedIn = (deltaMs: number, periodMs: number): number =>
  Math.max(0, Math.round(deltaMs / periodMs) - 1);

export function createFrames(): Frames {
  const slots = Array.from({ length: BUCKETS }, blank);
  /** Recent intervals, for the rate. A ring by hand, because `shift` on every frame is the cost. */
  const deltas: number[] = [];
  let at = 0;
  /** The bucket number of the newest slot; below zero until the first frame arrives. */
  let head = -1;
  let lastFrameAt: number | undefined;

  const slotOf = (bucket: number) => slots[((bucket % BUCKETS) + BUCKETS) % BUCKETS] ?? blank();

  /** Rolls forward to `bucket`, blanking everything skipped — a stalled tab leaves empty bars. */
  const advance = (bucket: number): void => {
    if (bucket <= head) return;
    const from = Math.max(head + 1, bucket - BUCKETS + 1);
    for (let n = from; n <= bucket; n += 1) Object.assign(slotOf(n), blank());
    head = bucket;
  };

  const period = (): number | undefined =>
    deltas.length < RATE_READY ? undefined : Math.min(...deltas);

  return {
    frame: (atMs) => {
      const bucket = Math.floor(atMs / BUCKET_MS);
      advance(bucket);
      const slot = slotOf(bucket);
      slot.frames += 1;
      const since = lastFrameAt === undefined ? undefined : atMs - lastFrameAt;
      lastFrameAt = atMs;
      if (since === undefined) return;
      if (since >= FASTEST_MS) {
        deltas[at % RATE_SAMPLES] = since;
        at += 1;
      }
      const known = period();
      if (known === undefined) return;
      const lost = droppedIn(since, known);
      if (lost === 0) return;
      // the gap is felt where it ended, which is the bucket the late frame landed in
      slot.dropped += lost;
      slot.blame = worse(slot.blame, "unattributed");
    },
    blocked: (startMs, durationMs, blame) => {
      const first = Math.floor(startMs / BUCKET_MS);
      // one bucket past the end, because the frame that reveals the gap lands after it closes
      const last = Math.min(Math.floor((startMs + durationMs) / BUCKET_MS) + 1, head);
      for (let n = Math.max(first, head - BUCKETS + 1); n <= last; n += 1) {
        const slot = slotOf(n);
        if (slot.dropped > 0) slot.blame = worse(slot.blame, blame);
      }
    },
    read: (nowMs) => {
      advance(Math.floor(nowMs / BUCKET_MS));
      const buckets = Array.from({ length: BUCKETS }, (_, n) => ({
        ...slotOf(head - BUCKETS + 1 + n),
      }));
      const measuring = lastFrameAt !== undefined && nowMs - lastFrameAt < STALLED_MS;
      // the bucket in flight is a fraction of a bucket, so counting it would read as a drop
      const complete = buckets.slice(-1 - SECOND, -1);
      const painted = complete.reduce((sum, bucket) => sum + bucket.frames, 0);
      return {
        buckets,
        fps: measuring && complete.length === SECOND ? painted : undefined,
        hz: period() === undefined ? undefined : Math.round(1000 / (period() ?? 1)),
        measuring,
        dropped: buckets.reduce((sum, bucket) => sum + bucket.dropped, 0),
        meshBlamed: buckets.some((bucket) => bucket.blame === "mesh"),
      };
    },
  };
}
