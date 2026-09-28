import type { Api } from "@syncmesh/orpc";

import { useEffect } from "react";

import type { Procedures } from "../procedures.js";

import { WORKSPACE_ID } from "../domain.js";

/**
 * The issues this tab has already counted a view for.
 *
 * **Opening an issue writes to the log, and that is a bigger thing than it looks.** The write is
 * signed, attributed to this device, replicated to every peer in the workspace and kept for as
 * long as the log is — for the act of *reading*. It was authored on every mount, and {@link Detail}
 * mounts per route match, so walking a list of twelve issues and back authored twenty-four events
 * nobody asked for. Left alone it reached 105 on one issue of a demo nobody had used for real,
 * and the number it was reporting had stopped being a fact about people and become a fact about
 * navigation.
 *
 * A view stays automatic, because asking someone to press a button to be counted measures button
 * presses. What it stops being is *per mount*: a view is now the first time this tab opens an
 * issue, which is the same definition every page-view counter on the web has settled on, and it
 * makes re-reading something free. The set is the tab's and dies with it, so a browser reopened
 * tomorrow counts tomorrow's reading — deliberately, since a set that outlived the tab would be
 * state to store, invalidate and get wrong for a column that is an approximation anyway.
 *
 * The column stays a PN-counter. Two people opening the same issue on two planes have both opened
 * it, and that is still the merge this app is demonstrating; see `procedures/writes.ts`.
 */
const counted = new Set<string>();

/**
 * The two things opening an issue does besides drawing it: it counts as a view, and it asks for a
 * number if the issue has none.
 *
 * **`claimNumber` is the only call in this app that leaves the device**, and it belongs here
 * rather than at filing time. Filing works with the authority switched off — that is the whole
 * claim the tracker makes — so numbering cannot be part of it; and a sweep over every unnumbered
 * issue would be a hundred round trips to decorate rows nobody is reading. One issue, when it is
 * opened, is the smallest thing that turns `ENG-•` into `ENG-4` while you watch.
 *
 * Unreachable is not an error path: the call fails naming itself and the bullet stays, which is
 * the reading the row already had. Asking twice is safe — the authority hands back the number it
 * minted rather than burning a second one.
 */
export function useOpened(
  api: Api<Procedures>,
  id: string,
  number: number | null | undefined,
): void {
  useEffect(() => {
    // once per issue per tab — see `counted` above
    if (counted.has(id)) return;
    counted.add(id);
    api.issues.view({ workspaceId: WORKSPACE_ID, id });
  }, [api, id]);

  useEffect(() => {
    if (number !== null) return;
    void api.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: id });
  }, [api, id, number]);
}
