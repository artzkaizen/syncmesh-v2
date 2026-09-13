import { panic } from "@syncmesh/result";
import { createContext, useContext } from "react";

import type { Replica } from "./replica.js";
import type { IssueLabelRow, IssueRow, LabelRow, MemberRow, ProjectRow, TeamRow } from "./view.js";

/**
 * The three contexts this app threads, and the hooks that read them.
 *
 * **A `.ts` file, because a context belongs to neither side of itself.** It is made once, provided
 * by a component and read by other components, so the module holding it is imported by both — and
 * React Fast Refresh only accepts a module whose every export is a component. A context or a hook
 * exported beside `<Workspace>` disqualifies that module *and every module that imports it*, which
 * here was all of them: touching `detail.tsx` reloaded the page, which tears down the dedicated
 * worker, re-runs the `navigator.locks` election and re-opens the OPFS database. Components live
 * in `.tsx`, everything else lives beside them in `.ts`, and an edit is a hot update again.
 *
 * Context rather than prop drilling for the replica is the ordinary reason. Context for the
 * catalog is a stronger one: teams, people, labels and projects are read by the header, the
 * sidebar, every row in the list and every line of the detail panel, and each of those asking for
 * itself would be five subscriptions per screen instead of five per app.
 */

export const ReplicaHeld = createContext<Replica | undefined>(undefined);

/** The workspace's small tables, plus the lookups every row does against them. */
export interface Catalog {
  readonly teams: readonly TeamRow[];
  readonly members: readonly MemberRow[];
  readonly labels: readonly LabelRow[];
  readonly projects: readonly ProjectRow[];
  /** Every label attachment in the workspace: one read behind a hundred rows of chips. */
  readonly tags: readonly IssueLabelRow[];
  readonly team: ReadonlyMap<string, TeamRow>;
  readonly member: ReadonlyMap<string, MemberRow>;
  readonly label: ReadonlyMap<string, LabelRow>;
  readonly project: ReadonlyMap<string, ProjectRow>;
}

export const CatalogHeld = createContext<Catalog | undefined>(undefined);

const NONE: readonly IssueRow[] = [];

/**
 * The rows this screen is currently drawing, for the panel drawn beside them.
 *
 * A context and not a prop because the panel is the layout's `<Outlet />` rather than its child,
 * and the array is the list's own snapshot passed by reference — nothing is copied and nothing is
 * cached, so the two views cannot drift. What it is *for* is in `view.ts`'s `panelFor`: a panel
 * whose own read comes back empty about a row the list is still drawing has not learned that the
 * row is absent, and must not say so.
 */
export const ShownRows = createContext<readonly IssueRow[]>(NONE);

/**
 * Panics rather than returning `undefined`, because a component rendered outside the provider is
 * a wiring mistake and not a state to draw. The alternative — an optional replica threaded
 * through every view — would put a null check in a hundred places to describe a situation that
 * cannot arise once.
 */
export const useReplica = (): Replica =>
  useContext(ReplicaHeld) ?? panic("a component asked for the replica outside <Workspace>");

export const useCatalog = (): Catalog =>
  useContext(CatalogHeld) ?? panic("a component asked for the catalog outside <Workspace>");

/** The rows on screen, empty outside the layout that provides them. */
export const useShownRows = (): readonly IssueRow[] => useContext(ShownRows);
