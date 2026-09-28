import { panic } from "@syncmesh/result";
import { createContext, useContext, useSyncExternalStore } from "react";

import type { Actor } from "../actor.js";
import type { Acting } from "./install.js";
import type { Replica } from "./replica.js";
import type { IssueLabelRow, IssueRow, LabelRow, MemberRow, ProjectRow, TeamRow } from "./view.js";

import { mesh } from "./mesh.js";
import { onReplica, replicaState } from "./replica.js";

/**
 * The three contexts this app threads, the hooks that read them, and the two doors onto the
 * client for the modules not yet reading `mesh.api` themselves.
 *
 * **A `.ts` file, because a context belongs to neither side of itself.** It is made once, provided
 * by a component and read by other components, so the module holding it is imported by both — and
 * React Fast Refresh only accepts a module whose every export is a component. A context or a hook
 * exported beside `<Workspace>` disqualifies that module *and every module that imports it*, which
 * here was all of them: touching `detail.tsx` reloaded the page, which tears down the dedicated
 * worker, re-runs the `navigator.locks` election and re-opens the OPFS database. Components live
 * in `.tsx`, everything else lives beside them in `.ts`, and an edit is a hot update again.
 *
 * **There is no context for the client.** `mesh.api` is a property of the module in `mesh.ts`,
 * bound once for the life of the tab, and `<mesh.Provider>` gates the tree on it; a context would
 * exist only to be imported. Context for the catalog is the real case: teams, people, labels and
 * projects are read by the header, the sidebar, every row in the list and every line of the
 * detail panel, and each of those asking for itself would be five subscriptions per screen
 * instead of five per app.
 */

/**
 * Who this install is acting as, which is the origin's answer and not this window's.
 *
 * A context rather than a field on the replica, because the two have different lifetimes and the
 * difference is load-bearing: a replica is replaced by a leader handover, and the actor survives
 * one; the actor is replaced by somebody using the picker, and the replica survives that. Holding
 * the second inside the first would make each of those events a lie about the other.
 */
export const ActingHeld = createContext<Acting | undefined>(undefined);

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
 * `mesh.api`, for `detail.tsx` and `routes/_shell/route.tsx`; every other screen reads it as the
 * property it is. Not a subscription: the client is one object for the life of the tab.
 */
export const useApi = (): typeof mesh.api => mesh.api;

/**
 * `mesh.api.$mesh` — the port half of the client — for the same two callers.
 *
 * Reaching for `operations` or handing the whole thing to devtools is what every caller of it
 * does; named so that a screen touching the mesh is a screen you can find.
 */
export const useFollower = (): typeof mesh.api.$mesh => mesh.api.$mesh;

/**
 * Whether this tab is durable, whether it holds the engine, and whether tabs can share one.
 *
 * A hook over the link this tab holds, because `role` moves on a leader handover; the snapshot
 * keeps its identity until the link changes. Panics under no link, because a component asking
 * outside `<mesh.Provider>` is a wiring mistake and not a state to draw.
 */
export const useTab = (): Pick<Replica, "durable" | "role" | "shared"> => {
  const { held } = useSyncExternalStore(onReplica, replicaState);
  return held?.replica ?? panic("a component asked which tab this is before a link was held");
};

export const useCatalog = (): Catalog =>
  useContext(CatalogHeld) ?? panic("a component asked for the catalog outside <Workspace>");

export const useActing = (): Acting =>
  useContext(ActingHeld) ?? panic("a component asked who this install is outside <Workspace>");

/**
 * Who every write this window makes is attributed to.
 *
 * The one every screen actually wants: a handler cannot ask the mesh who is calling — the grant
 * proves a *device* — so each write takes an `actorId`, and this is where it comes from.
 */
export const useActor = (): Actor => useActing().actor;

/** The rows on screen, empty outside the layout that provides them. */
export const useShownRows = (): readonly IssueRow[] => useContext(ShownRows);
