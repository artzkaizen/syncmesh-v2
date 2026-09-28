import { useCallback, useEffect, useRef, useState } from "react";

import type { DevtoolsStorage, PanelStateFailure } from "../persist.js";
import type { Corner, Dock, PanelState } from "../state.js";

import { readPanelState, writePanelState } from "../persist.js";
import { DEFAULT_PANEL_STATE } from "../state.js";

/**
 * Where the panel was last time, and where it goes when it moves.
 *
 * Read exactly once, in a lazy initialiser, so a storage that refuses does it during the first
 * render of one component instead of on every render of the tree; a refused read is not reported
 * at all, because the recovery — the defaults — is already the whole answer. Written from an
 * effect rather than from the updater, because `setItem` during render would run twice under
 * StrictMode and put a side effect in a function React is entitled to call speculatively.
 *
 * This hook is the only thing in the package that touches the host's storage.
 */

/** What an app may choose *before* the user has — which is once, on the first run at this key. */
export interface PanelSeed {
  readonly corner?: Corner | undefined;
  readonly dock?: Dock | undefined;
  readonly size?: number | undefined;
}

export interface PanelHandle {
  readonly state: PanelState;
  /** Merges and persists. Every change the panel can make goes through here, so there is one writer. */
  readonly set: (patch: Partial<PanelState>) => void;
  /**
   * The last refused write, surfaced as a value rather than logged into the host's console.
   *
   * A full origin or a sandboxed iframe costs the panel its memory and nothing else, so this is
   * not an error an app has to handle — but a devtool that silently forgets where it was put is a
   * devtool people report as broken, so the shell puts it in its title attribute.
   */
  readonly failure: PanelStateFailure | undefined;
}

const seeded = (seed: PanelSeed): PanelState => ({
  open: DEFAULT_PANEL_STATE.open,
  dock: seed.dock ?? DEFAULT_PANEL_STATE.dock,
  size: seed.size ?? DEFAULT_PANEL_STATE.size,
  corner: seed.corner ?? DEFAULT_PANEL_STATE.corner,
  tab: DEFAULT_PANEL_STATE.tab,
});

export function usePanelState(
  storage: DevtoolsStorage | undefined,
  key: string,
  seed: PanelSeed,
): PanelHandle {
  const [failure, setFailure] = useState<PanelStateFailure | undefined>(undefined);
  const [state, setState] = useState(() => {
    if (storage === undefined) return seeded(seed);
    const read = readPanelState(storage, key);
    return read.isErr() ? seeded(seed) : (read.value ?? seeded(seed));
  });

  const restored = useRef(true);
  useEffect(() => {
    // The first pass holds what was just read back, and writing that is a round trip for nothing.
    if (restored.current) {
      restored.current = false;
      return;
    }
    if (storage === undefined) return;
    const wrote = writePanelState(storage, key, state);
    setFailure(wrote.isErr() ? wrote.error : undefined);
  }, [storage, key, state]);

  const set = useCallback(
    (patch: Partial<PanelState>) => setState((previous) => ({ ...previous, ...patch })),
    [],
  );

  return { state, set, failure };
}
