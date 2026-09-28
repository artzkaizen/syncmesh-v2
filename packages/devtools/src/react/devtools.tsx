import type { ErrorInfo } from "react";

import { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";

import type { DevtoolsSource } from "../contract.js";
import type { DevtoolsControls } from "../controls.js";
import type { DevtoolsStorage } from "../persist.js";
import type { Corner, Dock } from "../state.js";
import type { DevtoolsTab } from "../tabs.js";
import type { Shortcut } from "./use-shortcut.js";

import { PREFIX } from "../css.js";
import { localStorageOf } from "../dom.js";
import { DEFAULT_STORAGE_KEY } from "../persist.js";
import { CORNERS } from "../state.js";
import { createTabRegistry } from "../tabs.js";
import { Bubble } from "./bubble.js";
import { forcedDetail, useForced } from "./forced.js";
import { Shell } from "./shell.js";
import { usePanelState } from "./use-panel-state.js";
import { useShadowHost } from "./use-shadow-host.js";
import { DEFAULT_SHORTCUT, formatShortcut, useShortcut } from "./use-shortcut.js";

/**
 * Drop this anywhere in an app's tree. While it is closed it is a button and a keydown listener.
 *
 * **Closed is free, and that is a requirement rather than a nicety.** An app ships the devtools in
 * development and, sooner or later, in production behind a flag; if having them installed cost a
 * subscription to the mesh, a poll, or a render of a panel body, the honest advice would be not to
 * install them. So: `source` is a factory this component never calls until the panel is open, the
 * {@link Shell} that calls it is not mounted while closed, and nothing here starts a timer or an
 * observer. The whole standing cost is one `keydown` handler on the document, which exists because
 * a bubble you have to go looking for is a bubble nobody finds.
 *
 * {@link SyncmeshDevtoolsProps.controls} is the one prop that changes what this thing *is*. Pass
 * none — which is what a production build does — and the inspector has no path to a mutator at
 * all: the panels read snapshots, and `DevtoolsSource` has no `add`, no `remove`, no `run`. Pass
 * one and the Transports panel can hold a medium in a condition a laptop cannot otherwise reach.
 * The opt-in is the safety property, so it is spelled as a prop a build can drop rather than as a
 * flag a build has to remember to set.
 */

export interface SyncmeshDevtoolsProps<Source = DevtoolsSource> {
  /**
   * The panels, in bar order. Data, so Events, Storage and Transports can be written by people who
   * never open this file — see {@link DevtoolsTab}.
   */
  readonly tabs: readonly DevtoolsTab<Source>[];
  /**
   * Called once, on the first render after the panel opens, and again after every reopen.
   *
   * `createMeshSource(mesh)` is what this is for, and the default type parameter says so: the
   * component was generic so that a test could hand it a number, not so that an app could invent
   * its own feed. A factory rather than a value, because building the source takes subscriptions
   * on a live engine and a devtool that is installed and shut must not hold any.
   *
   * It may answer with a **promise**, which is what `createRemoteSource(mesh)` does in a tab that
   * holds no engine: the first reading has to cross a port, so it cannot be there before the
   * panel's first render. The body says it is reaching the mesh until it lands.
   */
  readonly source: () => Source | Promise<Source>;
  /**
   * Called when the panel closes, with whatever `source` returned — `(held) => held.close()` for
   * a mesh source. Without it, closing the panel leaks every subscription it opened.
   */
  readonly dispose?: (source: Source) => void | undefined;
  /**
   * The operator surface, handed to every panel — and **absent by default**, which is the point.
   *
   * `createMeshControls(mesh)` is what this is for. An app that omits it installs an inspector
   * that cannot change the mesh it is inspecting, which is what a production build wants and what
   * makes the readings elsewhere in the panel worth trusting. Anything held through it is marked
   * on the bubble and named by `mesh.transports.forced()`, and nothing survives a reload.
   */
  readonly controls?: DevtoolsControls | undefined;
  /** Where a panel's thrown error goes after its boundary has caught and drawn it. */
  readonly onPanelError?: ((cause: unknown, info: ErrorInfo) => void) | undefined;
  /** Seeds, used on the first run at this storage key and ignored once the user has moved things. */
  readonly corner?: Corner | undefined;
  readonly dock?: Dock | undefined;
  readonly size?: number | undefined;
  /** `null` binds nothing; omitted, it is Ctrl+Shift+D. */
  readonly shortcut?: Shortcut | null | undefined;
  /** Namespaces the remembered state, so two meshes in one origin do not share a panel. */
  readonly storageKey?: string | undefined;
  /** Defaults to the ambient `localStorage`, and to remembering nothing where there is none. */
  readonly storage?: DevtoolsStorage | undefined;
}

/** Clockwise, and never off the end: a corner that does not exist would strand the bubble. */
const nextCorner = (corner: Corner): Corner =>
  CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length] ?? corner;

export function SyncmeshDevtools<Source = DevtoolsSource>(props: SyncmeshDevtoolsProps<Source>) {
  const { tabs, source, dispose, corner, dock, size, shortcut, storageKey, storage } = props;
  const { controls } = props;
  const forced = useForced(controls);
  const held = storage ?? localStorageOf();
  const seed = useMemo(() => ({ corner, dock, size }), [corner, dock, size]);
  const panel = usePanelState(held, storageKey ?? DEFAULT_STORAGE_KEY, seed);
  const registry = useMemo(() => createTabRegistry(tabs), [tabs]);
  const host = useShadowHost();

  const { set } = panel;
  const open = panel.state.open;
  const toggle = useCallback(() => set({ open: !open }), [set, open]);
  const bound = shortcut === null ? undefined : (shortcut ?? DEFAULT_SHORTCUT);
  useShortcut(bound, toggle);

  if (host === undefined) return null;

  const warning =
    panel.failure === undefined
      ? undefined
      : "Syncmesh inspector — this browser refused to remember the panel's position";

  return createPortal(
    <div className={`${PREFIX}-root`}>
      {open ? (
        <Shell
          controls={controls}
          create={source}
          dispose={dispose}
          onPanelError={props.onPanelError}
          registry={registry}
          set={set}
          state={panel.state}
          warning={warning}
        />
      ) : (
        <Bubble
          corner={panel.state.corner}
          forced={forced.length}
          hint={
            forced.length > 0
              ? forcedDetail(forced)
              : bound === undefined
                ? "Open the Syncmesh inspector"
                : `Open the Syncmesh inspector (${formatShortcut(bound)})`
          }
          onMove={() => set({ corner: nextCorner(panel.state.corner) })}
          onOpen={toggle}
        />
      )}
    </div>,
    host,
  );
}
