import type { SessionMarks } from "./boot.js";
import type { AppPhase, Knock } from "./transports.js";

/**
 * The session over a device's log, marked as the app moves between the foreground and the
 * background (D39, decided 2026-11-08): clean on the way to the background, where a phone or a
 * browser may end the process without warning, and open again on the way back. So the page check
 * an open runs after an unclean shutdown runs after a real crash, not after every swipe-away.
 *
 * Only a change is written: a page that says `hidden` and then `pagehide` marks once. Marks run
 * one after another, and {@link SessionPhases.settled} is what `stop()` waits on before it closes
 * the connection under them.
 */
export interface SessionPhases {
  /**
   * The app moved to `phase`; ignored once stopped, when the mesh marks no session, or with no
   * phase at all — a knock that only says the network moved.
   */
  readonly phase: (phase?: AppPhase) => void;
  /** Stops listening, and settles once every mark already begun has landed. */
  readonly settled: () => Promise<void>;
}

export function sessionPhases(session: SessionMarks | undefined): SessionPhases {
  // the open at boot marked the session open, and the app is in front when it boots
  let current: AppPhase = "foreground";
  let stopped = false;
  let marks: Promise<void> = Promise.resolve();
  return {
    phase: (phase) => {
      if (session === undefined || stopped || phase === undefined || phase === current) return;
      current = phase;
      marks = marks.then(phase === "background" ? session.clean : session.open);
    },
    settled: () => {
      stopped = true;
      return marks;
    },
  };
}

/** The part of a page's global scope {@link pagePhases} listens on; absent members mean no page. */
interface PageScope {
  readonly document?: {
    readonly visibilityState?: string;
    readonly addEventListener?: (type: string, listener: () => void) => void;
    readonly removeEventListener?: (type: string, listener: () => void) => void;
  };
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * A browser page's own lifecycle as phases: `visibilitychange` to `hidden` and `pagehide` are the
 * background, `visible` and `pageshow` the foreground. `undefined` where the mesh does not run on
 * a page — a server, a worker, React Native — which is how `createMesh` knows to listen by
 * default: on a page it always does, and no app code names it.
 *
 * Phases only: unlike an app's {@link Knock}s, a tab coming back does not redial every link.
 */
export function pagePhases(): Knock | undefined {
  // SAFETY: read member by member and each checked before use: on a page these are the DOM's own,
  // and anywhere else they are absent, which is what the shape says
  const scope = globalThis as PageScope;
  const page = scope.document;
  const on = scope.addEventListener;
  const off = scope.removeEventListener;
  if (page?.addEventListener === undefined || page.removeEventListener === undefined) return;
  if (on === undefined || off === undefined) return;
  const pageOn = page.addEventListener;
  const pageOff = page.removeEventListener;
  return (wake) => {
    const visibility = () => wake(page.visibilityState === "hidden" ? "background" : "foreground");
    const hide = () => wake("background");
    const show = () => wake("foreground");
    pageOn.call(page, "visibilitychange", visibility);
    on.call(globalThis, "pagehide", hide);
    on.call(globalThis, "pageshow", show);
    return () => {
      pageOff.call(page, "visibilitychange", visibility);
      off.call(globalThis, "pagehide", hide);
      off.call(globalThis, "pageshow", show);
    };
  };
}

/**
 * {@link sessionPhases}, listening to the page's own lifecycle wherever the mesh runs on one
 * ({@link pagePhases}); an app's knocks that know the phase report into {@link SessionPhases.phase}.
 */
export function followPhases(session: SessionMarks | undefined): SessionPhases {
  const phases = sessionPhases(session);
  const offPage = pagePhases()?.(phases.phase) ?? (() => undefined);
  return {
    phase: phases.phase,
    settled: () => {
      offPage();
      return phases.settled();
    },
  };
}
