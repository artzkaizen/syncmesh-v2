import { panic } from "@syncmesh/result";
import { createContext, useContext } from "react";

import type { Actor } from "../actor.js";
import type { Acting } from "./install.js";
import type { Replica } from "./replica.js";
import type { IssueLabelRow, IssueRow, LabelRow, MemberRow, ProjectRow, TeamRow } from "./view.js";

/**
 * The four contexts this app threads, and the hooks that read them.
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
 * Panics rather than returning `undefined`, because a component rendered outside the provider is
 * a wiring mistake and not a state to draw. The alternative — an optional replica threaded
 * through every view — would put a null check in a hundred places to describe a situation that
 * cannot arise once.
 */
/**
 * What a screen actually wants, named — rather than one bag it destructures two fields off.
 *
 * `Replica` is five unrelated facts: the api, the port to the worker holding the engine, and
 * three about *this tab's* storage situation. Handing all five to every component put a storage
 * noun in the signature of every screen in the app, and made "what does this screen depend on"
 * unanswerable without reading its body. Fifteen of the twenty call sites wanted `api` alone.
 *
 * The provider is unchanged; only the door is. `<Workspace>` still holds one object, because a
 * leader handover replaces all of it at once and splitting the *context* would let the three
 * halves disagree about which tab is live.
 */
const held = (): Replica =>
  useContext(ReplicaHeld) ?? panic("a component asked for the replica outside <Workspace>");

/** The procedures, bound to this origin's mesh. `api.issues.list(…)` and nothing else. */
export const useApi = (): Replica["api"] => held().api;

/**
 * The window's view of the origin's engine — a thin client over a port, never an engine itself.
 *
 * Four callers, and every one of them is reaching for `operations` or handing the whole thing to
 * devtools. Named rather than destructured out of a bag so that a screen touching the mesh is a
 * screen you can find.
 */
export const useFollower = (): Replica["mesh"] => held().mesh;

/** Whether this tab is durable, whether it holds the engine, and whether tabs can share one. */
export const useTab = (): Pick<Replica, "durable" | "role" | "shared"> => {
  const { durable, role, shared } = held();
  return { durable, role, shared };
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
