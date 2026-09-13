import { Result, TaggedError } from "@syncmesh/result";

import type { Corner, Dock, PanelState } from "./state.js";

import { CORNERS, DEFAULT_PANEL_STATE, MIN_SIZE } from "./state.js";

/**
 * The panel remembers where it was, and gets it wrong safely.
 *
 * Storage is the one place this package reads something it did not write: a key can be stale from
 * an older build, mangled by a second tab, or refused outright — `localStorage` throws on access
 * in a sandboxed iframe and on write when the origin is full. So every field is checked against a
 * value we recognise and every access is a `Result`. A devtool whose saved position can prevent an
 * app from booting is worse than no devtool.
 */

/** The `Storage` calls this makes. A browser's `localStorage` satisfies it, and so does a `Map` in a test. */
export interface DevtoolsStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

/** Storage refused, or held something that is not JSON. Carries the key, because an app may hold several panels. */
export class PanelStateFailure extends TaggedError("PanelStateFailure")<{
  readonly key: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export const DEFAULT_STORAGE_KEY = "syncmesh.devtools";

/**
 * What was actually in storage: every field optional and none of them trusted, which is what a key
 * written by a different build of this package is.
 */
interface RawPanelState {
  readonly open?: unknown;
  readonly dock?: unknown;
  readonly size?: unknown;
  readonly corner?: unknown;
  readonly tab?: unknown;
}

const KNOWN_CORNERS = new Set<string>(CORNERS);

/** The parse is the I/O boundary; everything after it is checking, not guessing. */
const parse = (text: string): RawPanelState => {
  const parsed: unknown = JSON.parse(text);
  // SAFETY: `JSON.parse` answers `any`, and this key may have been written by another build
  // entirely. `RawPanelState` claims nothing about the fields — each is compared against a value
  // this build ships before it is used, and a primitive here simply yields `undefined` throughout.
  return (parsed ?? {}) as RawPanelState;
};

const decode = (raw: RawPanelState): PanelState => {
  const dock: Dock = raw.dock === "right" ? "right" : "bottom";
  // SAFETY: guarded by the set of corners this build draws; anything else takes the default.
  const corner = KNOWN_CORNERS.has(raw.corner as string)
    ? (raw.corner as Corner)
    : DEFAULT_PANEL_STATE.corner;
  // SAFETY: `Number.isFinite` is the check — only a finite number reaches the floor. The ceiling
  // is not applied here: it depends on a viewport this function cannot see, so render does it.
  const size = Number.isFinite(raw.size)
    ? Math.max(MIN_SIZE, Math.round(raw.size as number))
    : undefined;
  // SAFETY: a tab id round-trips as JSON text, and a value that is not one names no installed tab.
  // The registry answers with its first tab in either case, so a wrong type costs a default.
  const tab = raw.tab === null ? undefined : (raw.tab as string | undefined);
  return {
    open: raw.open === true,
    dock,
    corner,
    size: size ?? DEFAULT_PANEL_STATE.size,
    tab,
  };
};

/**
 * `undefined` means nothing was stored, which is a first run and not a failure — the caller wants
 * to tell that apart from a remembered state that happens to match the defaults, because only on a
 * first run may the props an app passed decide where the panel starts.
 */
export function readPanelState(
  storage: DevtoolsStorage,
  key: string,
): Result<PanelState | undefined, PanelStateFailure> {
  const failed = (message: string) => (cause: unknown) =>
    new PanelStateFailure({ key, message, cause });
  return Result.try({ try: () => storage.getItem(key), catch: failed("read refused") }).andThen(
    (text: string | null) =>
      text === null
        ? Result.ok<PanelState | undefined, PanelStateFailure>(undefined)
        : Result.try({ try: () => parse(text), catch: failed("not JSON") }).map(decode),
  );
}

/**
 * Written whole on every change. The value is five short fields, so a diff would cost more to
 * maintain than the write it saves, and a partial write is a panel that reopens half-remembered.
 */
export function writePanelState(
  storage: DevtoolsStorage,
  key: string,
  state: PanelState,
): Result<void, PanelStateFailure> {
  return Result.try({
    try: () => storage.setItem(key, JSON.stringify(state)),
    catch: (cause) => new PanelStateFailure({ key, message: "write refused", cause }),
  });
}
