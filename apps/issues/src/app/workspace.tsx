import type { ReactNode } from "react";

import { useLiveQuery } from "@syncmesh/react";
import { useMemo } from "react";

import type { Replica } from "./replica.js";

import { CatalogHeld, ReplicaHeld } from "./context.js";
import { ReachBadge } from "./reach-badge.js";
import { byId } from "./view.js";

/**
 * The two things every screen needs and no screen should be handed down four levels of props:
 * the replica, and the small tables everything else is rendered *through*.
 *
 * The contexts themselves and the hooks that read them are in `context.ts`; this file provides
 * them and exports a component and nothing else, which is what keeps a hot update hot. The tables
 * are *live* subscriptions, not a snapshot taken at boot — rename a team on another device and the
 * chips change here without a reload, which is the whole point of holding them this way.
 */

export function Workspace({
  replica,
  children,
}: {
  readonly replica: Replica;
  readonly children: ReactNode;
}) {
  const { api } = replica;
  const teams = useLiveQuery(api.teams.list()).data;
  const members = useLiveQuery(api.members.list()).data;
  const labels = useLiveQuery(api.labels.list({})).data;
  const projects = useLiveQuery(api.projects.list({})).data;
  const tags = useLiveQuery(api.issueLabels.list()).data;

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
    <ReplicaHeld value={replica}>
      <CatalogHeld value={catalog}>
        {children}
        {/* above the screen rather than inside it, because what it reports is the device's and not
            this workspace's — and because it has to be drawn on every route, including the ones
            that are still being written */}
        <ReachBadge />
      </CatalogHeld>
    </ReplicaHeld>
  );
}
