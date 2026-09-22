import type { ReactNode } from "react";

import { useLiveQuery } from "@syncmesh/react";
import { useMemo } from "react";

import type { Acting } from "./install.js";

import { WORKSPACE_ID } from "../domain.js";
import { ActingHeld, CatalogHeld } from "./context.js";
import { mesh } from "./mesh.js";
import { Picker } from "./picker.js";
import { ReachBadge } from "./reach-badge.js";
import { Toasts } from "./toasts.js";
import { byId } from "./view.js";

/**
 * The two things every screen needs and no screen should be handed down four levels of props:
 * who this install is, and the small tables everything else is rendered *through*. The client
 * itself is `mesh.api`, a property, and needs no threading.
 *
 * The contexts themselves and the hooks that read them are in `context.ts`; this file provides
 * them and exports a component and nothing else, which is what keeps a hot update hot. The tables
 * are *live* subscriptions, not a snapshot taken at boot — rename a team on another device and the
 * chips change here without a reload, which is the whole point of holding them this way.
 */

export function Workspace({
  acting,
  children,
}: {
  readonly acting: Acting;
  readonly children: ReactNode;
}) {
  const { api } = mesh;
  const teams = useLiveQuery(api.teams.list({ workspaceId: WORKSPACE_ID })).data;
  const members = useLiveQuery(api.members.list({ workspaceId: WORKSPACE_ID })).data;
  const labels = useLiveQuery(api.labels.list({ workspaceId: WORKSPACE_ID })).data;
  const projects = useLiveQuery(api.projects.list({ workspaceId: WORKSPACE_ID })).data;
  const tags = useLiveQuery(api.issueLabels.list({ workspaceId: WORKSPACE_ID })).data;

  // the snapshots keep their identity between folds that did not touch these tables, so this
  // memo rebuilds the four indexes when the data changes and on no other render
  const catalog = useMemo(
    () => ({
      teams,
      members,
      labels,
      projects,
      tags,
      team: byId(teams),
      member: byId(members),
      label: byId(labels),
      project: byId(projects),
    }),
    [teams, members, labels, projects, tags],
  );

  return (
    <ActingHeld value={acting}>
      <CatalogHeld value={catalog}>
        {/* the picker instead of the app, and not a redirect to a route that draws it: an
            install nobody has answered for has no URL worth keeping, and a router that
            bounced every address to `/identity` would put a page in the history for a
            question rather than for a place. The roster it needs is one context up, which
            is the other reason it stands here */}
        {acting.chosen ? children : <Picker />}
        {/* above the screen rather than inside it, because what they report is the device's and
            not this workspace's — and because they have to be drawn on every route, including
            the ones that are still being written */}
        <ReachBadge />
        <Toasts />
      </CatalogHeld>
    </ActingHeld>
  );
}
