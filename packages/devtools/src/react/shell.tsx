import type { Result } from "@syncmesh/result";
import type { CSSProperties, ErrorInfo, KeyboardEvent } from "react";

import { createElement, useEffect, useRef, useState } from "react";

import type { DevtoolsControls } from "../controls.js";
import type { PanelState } from "../state.js";
import type { DevtoolsTab, DuplicateTabId, TabRegistry } from "../tabs.js";

import { PREFIX } from "../css.js";
import { clampSize } from "../state.js";
import { COLOR, SPACE } from "../tokens.js";
import { PanelBoundary } from "./boundary.js";
import { Icon } from "./icons.js";
import { Empty } from "./primitives/layout.js";
import { ShellHeader } from "./shell-header.js";
import { useResize, useViewportExtent } from "./use-resize.js";

/**
 * The open panel — and the only component in this package that knows the source exists.
 *
 * It mounts when the panel opens and unmounts when it closes, which is what makes "inert when
 * closed" true rather than aspirational: the source is built by this component's own lazy
 * initialiser, so a devtool that is installed and shut has never called the factory, never
 * subscribed, and never rendered a panel body. Reopening builds a fresh one, because a source kept
 * alive across a close is exactly the standing cost this design exists to avoid.
 */

export interface ShellProps<Source> {
  readonly registry: Result<TabRegistry<Source>, DuplicateTabId>;
  readonly state: PanelState;
  readonly set: (patch: Partial<PanelState>) => void;
  /** Non-empty when storage refused the last write; shown as the mark's tooltip, nowhere else. */
  readonly warning: string | undefined;
  /**
   * Built on the first render after the panel opens. **A promise is allowed, and is the reason
   * this signature is not simply `() => Source`:** a source that lives in another thread cannot
   * be constructed synchronously, and a window onto an origin's mesh is exactly that. While it is
   * in flight the body says so; a rejection says why, in the sentence the failure carried.
   */
  readonly create: () => Source | Promise<Source>;
  /** Called when the panel closes, with whatever `create` returned. */
  readonly dispose?: ((source: Source) => void) | undefined;
  /** Where a panel's thrown error is sent on its way past the boundary that caught it. */
  readonly onPanelError?: ((cause: unknown, info: ErrorInfo) => void) | undefined;
  /** Handed to every panel unchanged; absent is an inspector that can only watch. */
  readonly controls?: DevtoolsControls | undefined;
}

const frameOf = (state: PanelState, size: number): CSSProperties =>
  state.dock === "bottom"
    ? { left: 0, right: 0, bottom: 0, height: size, borderTop: `1px solid ${COLOR.hairlineStrong}` }
    : { top: 0, right: 0, bottom: 0, width: size, borderLeft: `1px solid ${COLOR.hairlineStrong}` };

const gripOf = (state: PanelState): CSSProperties =>
  state.dock === "bottom"
    ? { top: -4, left: 0, right: 0, height: 7, cursor: "ns-resize" }
    : { left: -4, top: 0, bottom: 0, width: 7, cursor: "ew-resize" };

export function Shell<Source>({
  registry,
  state,
  set,
  warning,
  create,
  dispose,
  onPanelError,
  controls,
}: ShellProps<Source>) {
  const [made] = useState(create);
  const settled = made instanceof Promise ? undefined : made;
  const [source, setSource] = useState<Source | undefined>(settled);
  const [refusal, setRefusal] = useState<string>();

  /**
   * `dispose` is read through a ref rather than depended on, and the reason is a bug this cost.
   *
   * A host writes `dispose={(held) => held.close()}` inline, which is a new function on every
   * render — so an effect that listed it as a dependency tore the source down and rebuilt it
   * whenever anything above re-rendered, and a panel would then read a source somebody had just
   * closed. The effect's subject is the source; the disposer is only how it is given back.
   */
  const disposer = useRef(dispose);
  disposer.current = dispose;

  useEffect(() => {
    if (!(made instanceof Promise)) return () => disposer.current?.(made);
    // a panel closed while the source was still crossing must still give it back: the host opened
    // its reader when this window subscribed, and nobody else is holding it
    let live = true;
    let arrived: Source | undefined;
    void made.then(
      (built) => {
        arrived = built;
        if (live) setSource(built);
        else disposer.current?.(built);
      },
      (cause: unknown) => {
        if (live) setRefusal(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
      if (arrived !== undefined) disposer.current?.(arrived);
    };
  }, [made]);

  const extent = useViewportExtent(state.dock);
  const size = extent === undefined ? state.size : clampSize(state.size, extent);
  const resize = useResize(state.dock, size, (next) => set({ size: next }));

  const tabs: readonly DevtoolsTab<Source>[] = registry.isOk() ? registry.value.tabs : [];
  const active = registry.isOk() ? registry.value.resolve(state.tab) : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    set({ open: false });
  };

  return (
    <section
      aria-label="Syncmesh inspector"
      onKeyDown={onKeyDown}
      style={{
        ...frameOf(state, size),
        position: "fixed",
        display: "flex",
        flexDirection: "column",
        background: COLOR.surface,
        color: COLOR.text,
        pointerEvents: "auto",
        boxShadow: "0 -8px 40px rgba(0, 0, 0, 0.5)",
      }}
    >
      <div
        aria-label="Resize the inspector"
        aria-orientation={state.dock === "bottom" ? "horizontal" : "vertical"}
        className={`${PREFIX}-grip`}
        data-dragging={resize.dragging}
        onKeyDown={resize.onKeyDown}
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        role="separator"
        style={{ ...gripOf(state), position: "absolute", touchAction: "none", zIndex: 1 }}
        tabIndex={0}
      />

      <ShellHeader
        active={active?.id}
        body={`${PREFIX}-body`}
        controls={controls}
        dock={state.dock}
        onClose={() => set({ open: false })}
        onDock={(dock) => set({ dock })}
        onSelect={(tab) => set({ tab })}
        tabs={tabs}
        title={warning ?? "Syncmesh inspector"}
      />

      <div
        className={`${PREFIX}-scroll`}
        id={`${PREFIX}-body`}
        role="tabpanel"
        style={{ flex: 1, minHeight: 0, padding: registry.isOk() ? 0 : SPACE.lg }}
      >
        {registry.isErr() ? (
          <Empty
            hint={`Two tabs were registered as "${registry.error.id}", so one of them could never be opened. Give each panel its own id.`}
            icon={<Icon name="close" size={20} />}
            title="Two panels claim the same id"
          />
        ) : active === undefined ? (
          <Empty
            hint="Pass at least one tab to <SyncmeshDevtools />. Panels are data: { id, label, icon, render }."
            icon={<Icon name="query" size={20} />}
            title="No panels are installed"
          />
        ) : refusal !== undefined ? (
          <Empty
            hint={refusal}
            icon={<Icon name="close" size={20} />}
            title="This mesh could not be read"
          />
        ) : source === undefined ? (
          <Empty
            hint="The mesh is in another thread of this origin, and its first reading is on its way."
            icon={<Icon name="query" size={20} />}
            title="Reaching the mesh"
          />
        ) : (
          // the panel body, and only the panel body: a tab that throws loses its own space and
          // leaves the tab bar, the dock and the bubble standing, which is what makes the next
          // tab one click away rather than a page reload
          <PanelBoundary id={active.id} label={active.label} onError={onPanelError}>
            {createElement(active.render, {
              source,
              controls,
              openTab: (tab: string) => set({ tab }),
            })}
          </PanelBoundary>
        )}
      </div>
    </section>
  );
}
