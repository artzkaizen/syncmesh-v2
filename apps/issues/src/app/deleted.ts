import type { FollowerMesh } from "@syncmesh/browser";

import { useEffect, useState } from "react";

import type { IssueDetailRow } from "./view.js";

/**
 * Whether the origin holds a tombstone for this issue, which is the difference between *deleted*
 * and *never heard of* — two facts every query answers with the same empty result.
 *
 * Asked across the port because the engine is in the worker, and re-asked whenever `rows` is
 * replaced, which is the right cadence rather than a convenient one: `issues.get` is a live query
 * over the same table, so the fold carrying another device's delete is exactly what produces a new
 * `rows`. One round trip rides behind a read that already ran, instead of a second subscription
 * with its own opinion about when to fire.
 *
 * `undefined` rows establish nothing — the read has not answered — so the last answer stands. A
 * port that refuses is the same: this panel keeps the sentence it could already justify rather
 * than upgrading a failure into a claim about the issue.
 */
export function useDeleted(
  mesh: FollowerMesh,
  id: string,
  rows: readonly IssueDetailRow[] | undefined,
) {
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    if (rows === undefined) return;
    // a row that is here is not deleted, whatever a tombstone underneath it says: an edit stamped
    // above the delete is the replica's answer to a concurrent pair, and the row is back
    if (rows.some((candidate) => candidate.id === id)) {
      setDeleted(false);
      return;
    }
    let live = true;
    void mesh.deleted("issue", id).then(
      (answer) => {
        if (live) setDeleted(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [mesh, id, rows]);
  return deleted;
}
