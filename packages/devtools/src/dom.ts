import type { DevtoolsStorage } from "./persist.js";

/**
 * The browser half of the inspector: the globals it reaches for, and the sheet it paints with.
 *
 * Its own entry (`@syncmesh/devtools/dom`) so that the root entry stays importable where there is
 * no DOM — React Native, a worker, a server render that only needs the contract. Nothing here is
 * reachable from `.`; a caller that wants it names it.
 *
 * Every access goes through `globalThis` and answers `undefined` when it is not there, for two
 * reasons that happen to point the same way. The repo's rule is that `packages/*` are
 * runtime-neutral (D01-B) and may not name `window` or `document` directly; and an app that
 * imports the devtools in a file it also renders on a server would otherwise crash during SSR,
 * before ever reaching a browser where the panel could have opened.
 *
 * Concentrating it here also means there is exactly one file to read to know what this package
 * touches outside itself — which, for something an app installs and forgets, is the honest answer
 * to "what does this cost me".
 */

/**
 * The stylesheet ships from this entry rather than its own. {@link STYLESHEET} is inert text, but
 * it is text only a DOM can read, and {@link PREFIX} names the classes it declares — splitting
 * them from the shadow root that adopts them would be two entries for one decision.
 */
export { PREFIX, STYLESHEET } from "./css.js";

export const documentOf = (): Document | undefined =>
  // SAFETY: the DOM lib declares `document` as always present, which is false in every runtime
  // that is not a browser; a property read off globalThis is absent there instead of throwing.
  (globalThis as { document?: Document }).document;

export const windowOf = (): Window | undefined =>
  // SAFETY: as above — the lib's global is a browser assumption, this read is not.
  (globalThis as { window?: Window }).window;

/**
 * Absent in a worker and in a sandboxed iframe, and throwing on *access* in some privacy modes —
 * which is why the caller gets `undefined` and every use of it afterwards is a `Result`.
 */
export const localStorageOf = (): DevtoolsStorage | undefined => {
  // SAFETY: read through the three calls in DevtoolsStorage and nothing else; a browser's Storage
  // is a superset of that shape, and anywhere without one the caller takes the undefined branch.
  const held = (globalThis as { localStorage?: DevtoolsStorage }).localStorage;
  return held;
};

/** The paint clock, as a pair, because a loop that cannot be cancelled is a leak with a timer. */
export interface FramePump {
  readonly request: (cb: (atMs: number) => void) => number;
  readonly cancel: (handle: number) => void;
}

/**
 * `requestAnimationFrame`, or `undefined` where nothing paints.
 *
 * Absent in a worker, in Node, and during SSR — and a caller that finds it absent must draw
 * nothing at all rather than a zero, because "this runtime does not paint" and "this tab has
 * stopped painting" are different facts and only the second one is a finding.
 */
export const framesOf = (): FramePump | undefined => {
  // SAFETY: both are declared by the DOM lib as always present, which is false off a browser; read
  // off globalThis they are absent instead of throwing, and bound so `this` survives the unpacking.
  const host = globalThis as {
    requestAnimationFrame?: (cb: (atMs: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const request = host.requestAnimationFrame;
  const cancel = host.cancelAnimationFrame;
  if (request === undefined || cancel === undefined) return undefined;
  return {
    request: (cb) => request.call(globalThis, cb),
    cancel: (h) => cancel.call(globalThis, h),
  };
};

/** What a caller needs off one long-frame record, and nothing this package cannot rely on. */
export interface LongFrameScript {
  readonly sourceURL?: string | undefined;
  readonly sourceFunctionName?: string | undefined;
  readonly invokerType?: string | undefined;
}

/**
 * One long animation frame, widened to what is actually guaranteed.
 *
 * `startTime` and `duration` are `PerformanceEntry`, so every browser that reports anything
 * reports those. `scripts` is the Long Animation Frames API's attribution and is **optional here
 * on purpose**: a browser without the API never sets it, and a cross-origin script is reported
 * without one. The type says what can be missing so the caller has to answer for it.
 */
export interface LongFrameEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly scripts?: readonly LongFrameScript[] | undefined;
}

export interface LongFrameWatch {
  readonly disconnect: () => void;
  /** Which entry type the browser accepted — the difference between attribution and a bare flag. */
  readonly kind: "long-animation-frame" | "longtask";
}

/**
 * Watches for long frames, preferring the API that can name what ran.
 *
 * `long-animation-frame` carries per-script `sourceURL` and `sourceFunctionName`; `longtask`
 * carries neither and can only say that something blocked. Both are tried and the better one wins,
 * and `undefined` means this browser offers neither — which the caller must render as *cannot
 * attribute* rather than as *nothing was blocking*.
 */
export const watchLongFrames = (
  note: (entries: readonly LongFrameEntry[], kind: LongFrameWatch["kind"]) => void,
): LongFrameWatch | undefined => {
  // SAFETY: the constructor is a browser global the DOM lib declares unconditionally; absent
  // everywhere else, where this read answers undefined instead of throwing.
  const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
    .PerformanceObserver;
  if (Observer === undefined) return undefined;
  // asked rather than attempted: `observe` throws on an entry type the browser has never heard of,
  // and a capability probe that has to be wrapped in a catch is a probe pretending to be a failure
  const known = new Set(Observer.supportedEntryTypes ?? []);
  const kind = (["long-animation-frame", "longtask"] as const).find((type) => known.has(type));
  if (kind === undefined) return undefined;
  const observer = new Observer((list) => note(list.getEntries(), kind));
  observer.observe({ type: kind, buffered: true });
  return { disconnect: () => observer.disconnect(), kind };
};
