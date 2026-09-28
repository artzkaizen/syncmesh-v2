import type { DevtoolsControls } from "../controls.js";
import type { Dock } from "../state.js";
import type { DevtoolsTab } from "../tabs.js";

import { PREFIX } from "../css.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { forcedDetail, forcedLabel, useForced } from "./forced.js";
import { Frames, useFrames } from "./frames.js";
import { Icon } from "./icons.js";
import { Tabs } from "./primitives/controls.js";
import { Cross } from "./primitives/layout.js";
import { Tag } from "./primitives/stat.js";

/**
 * One 34px strip holding the mark, the tabs and the window controls.
 *
 * The two vertical hairlines that separate them get a `+` where they meet the strip's own bottom
 * border, which is the same trick the frames use: it says these are gridlines, not dividers drawn
 * one at a time. Nothing here scrolls with the body, so the tabs stay reachable from a panel that
 * is a thousand rows deep.
 *
 * **Two things earn a permanent seat here, and the bar both had to clear is the same one.**
 * Anything in this strip is read for as long as the panel is open, so a seat costs whatever it
 * costs *on a fold* — and `fold` runs synchronously inside the write path. Every candidate counter
 * failed that bar: links held and peers reach `mesh.status.get()` and `peers.graph()`, unsettled
 * writes is a SQL query, and parked is zero forever on a healthy mesh.
 *
 * The two that pass do not read the mesh at all. The **held-medium mark** comes from
 * `controls.forced()`, a map the controls already hold, repainted only when somebody clicks; it is
 * the one state in this panel a person created and can forget, and the hole the bubble's mark
 * leaves is exactly *panel open, looking at another tab*. The **frames meter** is driven by
 * `requestAnimationFrame` and reads nothing, so its cost is independent of how busy the mesh is —
 * which is the property you want from the instrument that measures how busy the mesh is making the
 * main thread. It is present whether or not a host passed controls, because it measures the app
 * rather than the operator surface; it lives only while the panel is open, which is what keeps a
 * shut devtool free.
 *
 * The mark is a **mark, not a control**: the toggle lives beside the medium rows it acts on, and
 * the shell could not offer one here anyway without learning which tab those rows are on — and a
 * shell that knows a panel's id is a shell that has stopped treating tabs as data.
 */

export interface ShellHeaderProps<Source> {
  readonly tabs: readonly DevtoolsTab<Source>[];
  readonly active: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly dock: Dock;
  readonly onDock: (dock: Dock) => void;
  readonly onClose: () => void;
  /** Hover text for the mark — the place the panel admits it could not remember where it was. */
  readonly title: string;
  /** The id of the body the tabs swap. */
  readonly body: string;
  /** Absent for a host that passed none, and then this strip has nothing extra to draw. */
  readonly controls?: DevtoolsControls | undefined;
}

export function ShellHeader<Source>({
  tabs,
  active,
  onSelect,
  dock,
  onDock,
  onClose,
  title,
  body,
  controls,
}: ShellHeaderProps<Source>) {
  const forced = useForced(controls);
  const frames = useFrames();
  return (
    <header
      style={{
        position: "relative",
        display: "flex",
        alignItems: "stretch",
        height: 34,
        flex: "none",
        borderBottom: `1px solid ${COLOR.hairline}`,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: SPACE.sm,
          padding: `0 ${SPACE.md}px`,
          color: COLOR.textDim,
          borderRight: `1px solid ${COLOR.hairline}`,
        }}
        title={title}
      >
        <Icon name="mesh" size={14} strokeWidth={1.3} />
        <span style={{ ...TEXT.micro, color: COLOR.textDim }}>Syncmesh</span>
        <Cross at={{ right: -5, bottom: -5 }} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Tabs
          active={active}
          bordered={false}
          controls={body}
          items={tabs.map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon }))}
          onSelect={onSelect}
        />
      </div>

      {forced.length === 0 ? null : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: `0 ${SPACE.sm}px`,
            flex: "none",
          }}
          title={forcedDetail(forced)}
        >
          <Tag severity="high" variant="solid">
            {forcedLabel(forced)}
          </Tag>
        </div>
      )}

      {frames.reading === undefined ? null : (
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            padding: `0 ${SPACE.md}px`,
            flex: "none",
            borderLeft: `1px solid ${COLOR.hairline}`,
          }}
        >
          <Cross at={{ left: -5, bottom: -5 }} />
          <Frames {...frames} />
        </div>
      )}

      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: `0 ${SPACE.xs}px`,
          borderLeft: `1px solid ${COLOR.hairline}`,
        }}
      >
        <Cross at={{ left: -5, bottom: -5 }} />
        <button
          aria-label="Dock to the bottom"
          aria-pressed={dock === "bottom"}
          className={`${PREFIX}-btn`}
          onClick={() => onDock("bottom")}
          title="Dock to the bottom"
          type="button"
        >
          <Icon name="dock-bottom" size={14} />
        </button>
        <button
          aria-label="Dock to the right"
          aria-pressed={dock === "right"}
          className={`${PREFIX}-btn`}
          onClick={() => onDock("right")}
          title="Dock to the right"
          type="button"
        >
          <Icon name="dock-right" size={14} />
        </button>
        <button
          aria-label="Close the inspector"
          className={`${PREFIX}-btn`}
          onClick={onClose}
          title="Close (Esc)"
          type="button"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </header>
  );
}
