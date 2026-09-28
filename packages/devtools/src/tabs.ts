import type { ReactNode } from "react";

import { Result, TaggedError } from "@syncmesh/result";

import type { DevtoolsControls } from "./controls.js";

/**
 * The seam every panel is built against.
 *
 * A tab is **data**, not a branch in this file. The shell holds no list of panels and no `switch`
 * over their names, so Events, Storage, Transports and Queries can each be written, shipped and
 * deleted by someone who never opens the shell — and an app can install three of the four, or one
 * of its own, without a fork. This is the same reason a router takes routes instead of owning them.
 *
 * `Source` is the feed the panels read; the shell is generic over it because the shell does not
 * know and must not care what a panel needs. An app supplies one factory, every tab receives what
 * it produced.
 */
export interface DevtoolsTab<Source> {
  /**
   * Stable across releases: it is what gets written to storage as "the tab that was open", and a
   * rename silently drops a user back to the first panel.
   */
  readonly id: string;
  /** Shown in the tab bar. Sentence case, one or two words — the bar is narrow. */
  readonly label: string;
  /**
   * A 16px line glyph, rendered before the label. `ReactNode` rather than a name from a fixed set,
   * because a panel this shell has never heard of will need a glyph this shell does not ship.
   */
  readonly icon?: ReactNode | undefined;
  /**
   * The panel body. **Mounted as a component, not called as a function** — so hooks are allowed
   * inside it, and each tab keeps its own state across a switch away and back. The shell gives it
   * a scroll container and nothing else; the panel owns everything inside.
   */
  readonly render: (props: DevtoolsTabProps<Source>) => ReactNode;
}

export interface DevtoolsTabProps<Source> {
  /** Built once when the panel first opens, and thrown away when it closes. */
  readonly source: Source;
  /**
   * Cross-panel navigation: a row in Events wants to reach the query that produced it. An unknown
   * id is ignored rather than fatal — the target panel may simply not be installed here.
   */
  readonly openTab: (id: string) => void;
  /**
   * The one surface that can change the mesh, or **absent** where the host passed none.
   *
   * Optional and separate from `source` because that separation is the safety property: an app
   * that installs the panels without controls has an inspector that cannot touch the thing it is
   * measuring, and a production build gets there by passing one prop fewer. A panel treats absence
   * the way it treats an absent `storage` or `sql` — it says so in a sentence, rather than drawing
   * a control that does nothing.
   *
   * Not generic over `Source`: the panels are generic because the shell must not know what they
   * read, but what a control *does* is a fixed vocabulary about this mesh's mediums.
   */
  readonly controls?: DevtoolsControls | undefined;
}

/** Two tabs claimed the same `id`, so one of them was about to become unreachable. */
export class DuplicateTabId extends TaggedError("DuplicateTabId")<{ id: string }> {}

export interface TabRegistry<Source> {
  /** In the order given. The tab bar draws them left to right, and the first one is the default. */
  readonly tabs: readonly DevtoolsTab<Source>[];
  /**
   * The tab to show for a remembered id: that tab, or the first installed one.
   *
   * Falling back rather than failing because the remembered id outlives the install that wrote it
   * — a user who last had "storage" open and then upgrades to a build without it should land on a
   * panel, not on an empty body with a name in it.
   */
  readonly resolve: (id: string | undefined) => DevtoolsTab<Source> | undefined;
}

/**
 * Checks the ids are unique up front, because the alternative is a tab bar with two entries that
 * open the same panel and no way to tell which one is shadowed.
 */
export function createTabRegistry<Source>(
  tabs: readonly DevtoolsTab<Source>[],
): Result<TabRegistry<Source>, DuplicateTabId> {
  const byId = new Map<string, DevtoolsTab<Source>>();
  for (const tab of tabs) {
    if (byId.has(tab.id)) return Result.err(new DuplicateTabId({ id: tab.id }));
    byId.set(tab.id, tab);
  }
  return Result.ok({
    tabs,
    resolve: (id) => (id === undefined ? tabs[0] : (byId.get(id) ?? tabs[0])),
  });
}
