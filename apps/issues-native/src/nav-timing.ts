import Constants from "expo-constants";
import { useNavigation } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { MEASURING } from "./measuring";

/**
 * How long a tap takes to become pixels — measured at every stage, because they have different
 * causes and only one of them is the database.
 *
 * **The first version of this file measured the wrong thing.** It stopped the clock when React
 * *began* rendering the new screen, reported 43ms, and was completely honest and completely
 * useless: a person does not perceive a render beginning. They perceive the frame that finally
 * shows the screen, which is after React commits, after the native push animation runs, and after
 * the compositor presents it. Those later stages are where a "this feels slow" lives.
 *
 * The spans this reports, and what each one accuses:
 *
 * | span | what it means | what to fix if it is the big one |
 * | --- | --- | --- |
 * | `tap→render` | JS was busy before the new screen even started rendering | work on the press handler, or a blocked thread |
 * | `render→commit` | the screen's own render pass | queries opened during render (`useLiveQuery` calls `live()` in a `useMemo`), heavy children |
 * | `commit→paint` | React committed, the frame callback that proves pixels has not run | see below — this one named no culprit until it was split |
 *
 * **`commit→paint` on its own accuses everything and convicts nothing, and it was read as a verdict
 * for a whole session.** Three unrelated faults produce the same number — a JS thread that never
 * yields, a JS thread that yields a hundred times because a tree is re-rendering in a loop, and a
 * main thread so busy compositing that no frame callback arrives at all. They want opposite fixes,
 * so the second line this prints says which one it was:
 *
 * - **`js turns`** is a `setTimeout(…, 0)` loop started at the commit. Each turn is one trip
 *   through the JS queue, so *few turns with a long one* is a single blocking call, and *many
 *   turns* is a re-render storm. Either way the JS thread is the problem.
 * - **`frames`** is every frame callback over the same window. Frames arriving on time while the
 *   timer loop is starved means React is the problem; frames stopping while the timer loop runs
 *   freely means the main thread is, and no amount of memoizing will move it.
 * - **`subtree`** counts component renders underneath the screen (see {@link sawSubtreeRender}),
 *   which is what turns "something re-rendered" into a number.
 *
 * **The push animation is measured now, and it turned out to contain the whole mystery.**
 * `InteractionManager.runAfterInteractions` was tried for it and reported `0ms` every time, because
 * a native stack transition is not a JS interaction — so the number was not "the animation is
 * free", it was "this cannot see the animation". What can see it is UIKit itself: the screen being
 * *covered* by a push gets `viewWillDisappear` when the animation starts and `viewDidDisappear`
 * when it ends, and `react-native-screens` forwards both as `transitionStart` and `transitionEnd`
 * with `closing: true`. {@link useNativeTransition} listens for them — passively, on the screen a
 * person is leaving, reporting an animation it never asks for.
 *
 * **What it found is that the animation happens entirely after `VISIBLE AT`, and is not a tenth of
 * the problem.** On this simulator the push runs a steady 475–500ms — longer than the 350ms iOS is
 * usually quoted at — and it does not *start* until the paint callback has already fired, because
 * UIKit cannot begin a transition while the commit that mounts the incoming screen is still being
 * flushed. So `VISIBLE AT` is the optimistic half of the story and `settled at` is the whole of it:
 * a push that paints at 533ms settles at about a second.
 *
 * `animation: "none"` takes `push ran` from ~480ms to **1ms**. `animationDuration` changes nothing
 * at all on iOS, and `animation: "fade"` is slightly *slower* than the default — both measured,
 * both worth not trying twice.
 *
 * **Every line says which device it came from.** Metro pools the console of every client it is
 * serving into one stream with no attribution, so a phone and a simulator reading the same bundle
 * produce identical-looking lines — and a measurement whose device is a guess is not a measurement.
 *
 * **Off unless {@link MEASURING} is turned on**, and deliberately a handful of `Date.now()` calls
 * — a profiler that costs enough to change the number it reports is a profiler that is lying to
 * you. That last part is why the switch exists rather than just the sentence: the samplers are two
 * loops on the JS thread, and they used to run on every push in the app on somebody's phone.
 */

/**
 * Which device this line came from — the name the hardware calls itself.
 *
 * "iPhone 16e" and "iPhone 17" are simulators here; a phone reports the bare model, because iOS 16
 * stopped handing out the owner's name to apps without an entitlement. That is enough to tell the
 * clients of one Metro apart, which is the point rather than a nicety: a simulator runs the
 * compositor on a Mac, and mixing the two in one log is how a measurement becomes a guess.
 *
 * There is deliberately no "is this a simulator" flag. `Constants.isDevice` reads as `undefined`
 * on this version — it lives in `expo-device`, which this app does not depend on — so a check
 * against it compiles, runs, and is always false. A marker that can never appear is worse than no
 * marker, because the first reader to see its absence concludes they are on real hardware.
 */
export const WHERE = Constants.deviceName ?? Platform.OS;

/**
 * How long the samplers keep watching after the commit.
 *
 * Long enough to cover a push animation and whatever follows it, short enough that the next tap is
 * never sampling the last one.
 */
const WATCH_MS = 1200;

interface Marks {
  readonly what: string;
  readonly tapped: number;
  /** Every `sawRender` call, not just the first — a screen that renders nine times says so. */
  renders: number;
  /** Renders of components *inside* the screen, which is where a re-render storm is visible. */
  subtree: number;
  rendered?: number;
  committed?: number;
  /** One entry per trip through the JS task queue: the JS thread's own availability. */
  readonly turns: number[];
  /** One entry per frame callback: the main thread's. */
  readonly frames: number[];
  /**
   * When the JS thread next went idle, from a microtask.
   *
   * The discriminator between the two stalls that look identical in every other number here: both
   * `setTimeout` and `requestAnimationFrame` are driven from the native side in React Native, so a
   * gap in {@link turns} is as much a busy UI thread as a busy JS one. A microtask needs no timer
   * and no thread but this one, so an idle at +2ms against a first frame at +700ms says the
   * JavaScript was already done and the stall is native — mounting the view tree, not computing it.
   */
  settled?: number;
  painted?: number;
  /** `viewWillDisappear` on the screen being covered — UIKit has started the push. */
  pushBegan?: number;
  /** `viewDidDisappear` on the same screen — the push animation is over. */
  pushEnded?: number;
}

let run: Marks | undefined;

/**
 * Whether this build measures navigation at all. **Off, and edited by hand to turn on.**
 *
 * The header above has always said "development only"; nothing enforced it, so it ran on every
 * push in the app on a real phone. That is worse than a wasted cycle, because of what the sampling
 * *is*: a `setTimeout(…, 0)` loop and a `requestAnimationFrame` loop, both for {@link WATCH_MS}
 * after every commit, both on the JS thread — the same thread whose stalls they exist to catch.
 * An instrument that competes with what it measures reports a number that includes itself.
 *
 * The switch is shared with `sql-trace` in `./measuring`, because they are one decision — a
 * person reading either one is reading both. Nothing else here needs a guard: every other entry
 * point is already a cheap early return while no run is open, so a false `MEASURING` makes the
 * whole file inert.
 */

/** The instant a row was pressed, before any navigation has been asked for. */
export function sawTap(what: string): void {
  if (!MEASURING) return;
  run = { what, tapped: Date.now(), renders: 0, subtree: 0, turns: [], frames: [] };
}

/** The new screen's render pass started — the end of whatever blocked the transition. */
export function sawRender(): void {
  if (run === undefined) return;
  run.renders += 1;
  run.rendered ??= Date.now();
}

/**
 * A component under the screen rendered.
 *
 * Called from the leaf components a screen draws many of, so "the tree re-rendered" stops being a
 * suspicion and becomes a count. One increment is one React render of one component, which is the
 * only unit that distinguishes a screen that drew once from a screen that drew forty times before
 * anybody saw it.
 */
export function sawSubtreeRender(): void {
  if (run !== undefined) run.subtree += 1;
}

/**
 * What a native stack transition reports about itself, which is the only part of it JS can see.
 *
 * Declared here rather than imported because `NativeStackNavigationProp` is not on any public entry
 * point of `expo-router` — the vendored navigator's types live under `build/`, and reaching into
 * that is a worse dependency than naming the two fields this file actually reads.
 */
interface Transitions {
  addListener(
    type: "transitionStart" | "transitionEnd",
    listener: (event: { readonly data: { readonly closing: boolean } }) => void,
  ): () => void;
}

/**
 * Watch the push animation from the screen it is pushing *away from*.
 *
 * **Purely an observer.** It subscribes to events UIKit emits on its own and writes down when they
 * arrived; nothing here navigates, taps, or schedules a transition. `closing: true` is the filter
 * that keeps it to pushes: the same pair of events fires with `closing: false` when this screen is
 * uncovered again by a pop, and folding the two together would report a push that lasted as long as
 * the person spent reading.
 *
 * It belongs on the *outgoing* screen because that is the one still mounted for the whole
 * transition. The screen being pushed mounts partway through its own animation and cannot time it.
 */
export function useNativeTransition(): void {
  const navigation = useNavigation<Transitions>();
  useEffect(
    () =>
      navigation.addListener("transitionStart", ({ data }) => {
        if (data.closing && run !== undefined) run.pushBegan ??= Date.now();
      }),
    [navigation],
  );
  useEffect(
    () =>
      navigation.addListener("transitionEnd", ({ data }) => {
        if (data.closing && run !== undefined) run.pushEnded ??= Date.now();
      }),
    [navigation],
  );
}

/**
 * React has committed the tree, and the rest is the platform's.
 *
 * Call from a layout effect. Two samplers start here and they watch different threads: a
 * self-rescheduling zero-delay timer, which only runs when the JS queue drains, and a frame loop,
 * whose second callback is the closest a JS thread can get to "the frame was presented". Both keep
 * going for {@link WATCH_MS} past the commit, because the interesting part of a slow transition is
 * usually the gap *after* the screen is nominally visible.
 */
export function sawCommit(): void {
  const marks = run;
  if (marks === undefined || marks.committed !== undefined) return;
  const committed = Date.now();
  marks.committed = committed;
  void Promise.resolve().then(() => void (marks.settled ??= Date.now()));
  const turn = () => {
    if (run !== marks) return;
    const now = Date.now();
    marks.turns.push(now);
    if (now - committed < WATCH_MS) setTimeout(turn, 0);
  };
  setTimeout(turn, 0);
  const frame = () => {
    if (run !== marks) return;
    const now = Date.now();
    marks.frames.push(now);
    if (marks.frames.length === 2) marks.painted = now;
    if (now - committed < WATCH_MS) {
      requestAnimationFrame(frame);
      return;
    }
    report(marks);
    run = undefined;
  };
  requestAnimationFrame(frame);
}

/**
 * The stall that mattered, as the gap between two consecutive samples and where it started.
 *
 * Reported rather than the whole list because forty timestamps are not readable and one number is:
 * a transition that dropped a third of a second has exactly one gap worth naming.
 */
const worstGap = (from: number, samples: readonly number[]) => {
  let at = 0;
  let gap = 0;
  let previous = from;
  for (const sample of samples) {
    if (sample - previous > gap) {
      gap = sample - previous;
      at = previous - from;
    }
    previous = sample;
  }
  return `${String(gap)}ms at +${String(at)}ms`;
};

const report = (marks: Marks): void => {
  const { committed = marks.tapped, frames, rendered = marks.tapped, tapped, turns } = marks;
  const settled = marks.settled ?? committed;
  const painted = marks.painted ?? committed;
  const span = (from: number, to: number) => `${String(to - from)}ms`;
  /* eslint-disable no-console -- the number is the whole point, and a log outlives a screen */
  console.log(
    `[nav] ${WHERE} · ${marks.what} · tap→render ${span(tapped, rendered)} · render→commit ${span(rendered, committed)} · commit→paint ${span(committed, painted)} · VISIBLE AT ${span(tapped, painted)}`,
  );
  console.log(
    `[nav+] ${WHERE} · ${marks.what} · renders ${String(marks.renders)} · subtree ${String(marks.subtree)} · js idle at +${String(settled - committed)}ms · js turns ${String(turns.length)} worst ${worstGap(committed, turns)} · frames ${String(frames.length)} worst ${worstGap(committed, frames)}`,
  );
  // the animation, and the two numbers that say whether `commit→paint` is hiding inside it
  const { pushBegan, pushEnded } = marks;
  console.log(
    pushBegan === undefined
      ? `[nav>] ${WHERE} · ${marks.what} · no native transition reported`
      : `[nav>] ${WHERE} · ${marks.what} · tap→push ${span(tapped, pushBegan)} · push ran ${pushEnded === undefined ? "past the window" : span(pushBegan, pushEnded)} · SETTLED AT ${pushEnded === undefined ? "past the window" : span(tapped, pushEnded)}`,
  );
  /* eslint-enable no-console */
};
