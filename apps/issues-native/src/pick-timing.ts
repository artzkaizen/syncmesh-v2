import { WHERE } from "./nav-timing";

/**
 * Where the time goes between pressing a choice and the sheet being gone.
 *
 * The complaint this answers is "it does not close immediately, and I don't know what it's doing",
 * and the four spans below are the four different answers that feel identical from the outside:
 *
 * - **press→handed** is the write's synchronous head — validating the input, taking the handle's
 *   turn and opening the transaction. Nothing has been sent anywhere; this is local work done on
 *   the thread the close is waiting for.
 * - **handed→shut** is React: the state change re-rendering the screen and everything under it,
 *   through to the commit where the sheet is told to close.
 * - **shut→frame** is the gap before the first frame after that commit, which is the animation
 *   actually starting rather than being queued behind something.
 * - **worst frame** is the longest stall inside the closing animation, which is what a person
 *   reads as the sheet sticking on its way down.
 *
 * Nothing here observes the network, on purpose. A statement commits locally and returns; if these
 * numbers are large it is this device that is busy, and no acknowledgement is being waited on.
 */

/** Long enough to cover a sheet dismissal and the frames after it, short enough not to overlap. */
const WATCH_MS = 900;

interface Marks {
  readonly what: string;
  readonly pressed: number;
  handed?: number;
  shut?: number;
  readonly frames: number[];
  /**
   * When the JS thread next went idle, from a microtask — needs no timer and no native thread.
   *
   * The discriminator: an idle at +3ms against a first frame at +188ms says the JavaScript was
   * already done and the stall is the native side, and the reverse says the opposite. Both
   * `setTimeout` and `requestAnimationFrame` are delivered through native modules here, so neither
   * of them can tell those apart alone.
   */
  settled?: number;
  /** One entry per trip through the JS task queue, for where the JS thread went if it was busy. */
  readonly turns: number[];
}

let run: Marks | undefined;

/** A choice was pressed — starts a run, discarding any still open. */
export const sawPick = (what: string): void =>
  void (run = { what, pressed: Date.now(), frames: [], turns: [] });

/** The write has been handed off and returned; whatever it does next is no longer in this handler. */
export const sawHandedOff = (): void =>
  void (run === undefined ? undefined : (run.handed ??= Date.now()));

/** The sheet's `isOpen` has committed as false: from here it is frames, not JavaScript. */
export function sawSheetShut(): void {
  const marks = run;
  if (marks === undefined || marks.shut !== undefined) return;
  const shut = Date.now();
  marks.shut = shut;
  void Promise.resolve().then(() => void (marks.settled ??= Date.now()));
  const turn = (): void => {
    if (run !== marks) return;
    const now = Date.now();
    marks.turns.push(now);
    if (now - shut < WATCH_MS) setTimeout(turn, 0);
  };
  setTimeout(turn, 0);
  const frame = (): void => {
    if (run !== marks) return;
    const now = Date.now();
    marks.frames.push(now);
    if (now - shut < WATCH_MS) {
      requestAnimationFrame(frame);
      return;
    }
    report(marks);
    run = undefined;
  };
  requestAnimationFrame(frame);
}

const worstGap = (from: number, samples: readonly number[]): string => {
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
  const { frames, pressed, shut = pressed, turns } = marks;
  const settled = marks.settled ?? shut;
  const handed = marks.handed ?? pressed;
  const span = (from: number, to: number) => `${String(to - from)}ms`;
  const first = frames[0];
  // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
  console.log(
    `[pick] ${WHERE} · ${marks.what} · press→handed ${span(pressed, handed)} · handed→shut ${span(handed, shut)} · shut→frame ${first === undefined ? "never" : span(shut, first)} · GONE AT ${first === undefined ? "?" : span(pressed, first)}`,
  );
  // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
  console.log(
    `[pick+] ${WHERE} · ${marks.what} · js idle at +${String(settled - shut)}ms · js turns ${String(turns.length)} worst ${worstGap(shut, turns)} · frames ${String(frames.length)} worst ${worstGap(shut, frames)}`,
  );
};
