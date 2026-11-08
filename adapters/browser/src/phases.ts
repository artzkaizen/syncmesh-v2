import type { AppPhase, Knock } from "@syncmesh/client";

/**
 * The phase of every window an origin's host serves, as the one phase its mesh hears (D39, U32).
 *
 * A mesh on a page hears the page's lifecycle by itself; the mesh in the elected tab's worker has
 * no `document` and hears nothing, so it would never mark its session clean and the next open
 * would check the log page by page after every close. Each window tells the host its phase over
 * its link, {@link serveMesh} works out the origin's, and this carries it into the mesh as a
 * {@link Knock}: `background` once no window is shown, `foreground` when one is again — which
 * also wakes every transport, as an app coming back to the front does.
 *
 * Made before the mesh, because a knock is passed to the mesh at construction, and handed to
 * `serveMesh` after.
 *
 * @example
 * // the elected tab's dedicated worker
 * const phases = createTabPhases();
 * const app = createClient({ schema, storage, knocks: [phases.knock] });
 * await app.$ready;
 * const host = serveMesh(app.$mesh, { phases });
 */
export interface TabPhases {
  /** Pass in the mesh's `knocks`; it hears the origin's phase from then on. */
  readonly knock: Knock;
  /** The origin's phase moved; `serveMesh` calls it, once per change. */
  readonly tell: (phase: AppPhase) => void;
}

/**
 * Creates the knock an origin's host reports into; see {@link TabPhases}.
 *
 * A mesh that starts listening after the origin went to the background hears `background` at
 * once, since it boots believing it is in front; a `foreground` it would only redial on is not
 * repeated.
 */
export function createTabPhases(): TabPhases {
  const listeners = new Set<(phase?: AppPhase) => void>();
  let current: AppPhase = "foreground";
  return {
    knock: (wake) => {
      listeners.add(wake);
      if (current === "background") wake(current);
      return () => void listeners.delete(wake);
    },
    tell: (phase) => {
      current = phase;
      for (const wake of listeners) wake(phase);
    },
  };
}

/** The part of a page's global scope {@link pagePhase} reads; absent where there is no page. */
interface PageScope {
  readonly document?: {
    readonly visibilityState?: string;
    readonly addEventListener?: (type: string, listener: () => void) => void;
    readonly removeEventListener?: (type: string, listener: () => void) => void;
  };
}

/** A page's phase: read now, or watched until the returned function is called. */
interface PagePhase {
  readonly now: () => AppPhase;
  readonly watch: (tell: (phase: AppPhase) => void) => () => void;
}

/**
 * This page's phase now, and as it changes: `hidden` is the background, anything else the
 * foreground. `undefined` where there is no page to watch, as in a test runner.
 *
 * `pagehide` is not here: a page going away says `bye` on its link, which is that window leaving
 * the origin's count altogether.
 */
export function pagePhase(): PagePhase | undefined {
  // SAFETY: read member by member and each checked before use: on a page these are the DOM's own,
  // and anywhere else they are absent, which is what the shape says
  const page = (globalThis as PageScope).document;
  const on = page?.addEventListener;
  const off = page?.removeEventListener;
  if (page === undefined || on === undefined || off === undefined) return undefined;
  const now = (): AppPhase => (page.visibilityState === "hidden" ? "background" : "foreground");
  return {
    now,
    watch: (tell) => {
      const changed = () => tell(now());
      on.call(page, "visibilitychange", changed);
      return () => off.call(page, "visibilitychange", changed);
    },
  };
}

/** The windows a host serves, by what each last said of its page; see {@link createWindowCount}. */
export interface WindowCount<W> {
  readonly arrive: (window: W) => void;
  readonly say: (window: W, phase: AppPhase) => void;
  readonly leave: (window: W) => void;
  /** Says nothing from now on: the windows are being let go, not put away. */
  readonly stop: () => void;
}

/**
 * Counts the windows a host serves and tells `phases` the origin's phase, once per change.
 *
 * The origin is in front while any window is shown. A window that has not said counts as shown,
 * the safe direction: the session stays open. The mesh boots in front, so nothing is said until
 * that changes — a host with no window yet has not sent anything to the background.
 */
export function createWindowCount<W>(phases: TabPhases | undefined): WindowCount<W> {
  const windows = new Map<W, AppPhase | undefined>();
  let origin: AppPhase = "foreground";
  let stopped = false;
  const recount = (): void => {
    if (phases === undefined || stopped) return;
    const shown = Array.from(windows.values()).some((phase) => phase !== "background");
    const now = shown ? "foreground" : "background";
    if (now === origin) return;
    origin = now;
    phases.tell(now);
  };
  return {
    arrive: (window) => {
      windows.set(window, undefined);
      recount();
    },
    say: (window, phase) => {
      if (!windows.has(window)) return;
      windows.set(window, phase);
      recount();
    },
    leave: (window) => {
      if (windows.delete(window)) recount();
    },
    stop: () => {
      stopped = true;
    },
  };
}
