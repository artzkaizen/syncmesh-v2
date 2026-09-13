import { useOperation } from "@syncmesh/react";

import { useReplica } from "./context.js";
import { syncNote } from "./sync-note.js";
import { COLOR, SEVERITY_COLOR, TEXT } from "./ui.js";

/**
 * Where this row's own write has got to — **on the two occasions that is worth saying**.
 *
 * Two facts, from two places, and they answer different questions. `local`, `delivered` or
 * `remote` is the **row's** reach, which crosses the port as an answer the host gives and re-asks
 * itself whenever a fold, a write or an ack could have moved it. `applied` is the **write's**
 * durable record — the operation the row's `operationOf` column names — which says whether what
 * this device asked for is what the mesh kept, or whether an authority overruled it.
 *
 * Both are the origin's, read across the port: there is one log and one ledger for this device
 * however many windows are open on it, so a write made in the other tab reads the same here.
 *
 * What changed is that neither is drawn in the ordinary case. `sync-note.ts` carries the argument;
 * the short version is that this header is read by somebody who wants to know about an *issue*,
 * and `delivered · applied` is the answer to a question about the *mesh*. The inspector is one
 * keystroke away and holds the whole ledger, per write, which is where that answer belongs.
 */
export function SyncBadge({
  sync,
  operation,
}: {
  /**
   * Where this row's own write got to, **selected with the row** (`syncOf`).
   *
   * It used to be read through a second subscription keyed by table name and row id, which is why
   * it flickered: the row and its reach were two answers arriving at two times, so a badge could
   * draw the previous issue's reach beside this issue's title for a frame. A column cannot do
   * that — it is in the row or it is not.
   */
  readonly sync: "local" | "delivered" | "remote" | null | undefined;
  /** `undefined` is *not read yet*, not "no operation"; see `view.ts`'s `Panel`. */
  readonly operation: string | null | undefined;
}) {
  const { mesh } = useReplica();
  const note = syncNote(sync ?? undefined, useOperation(mesh.operations, operation ?? undefined));
  if (note === undefined) return null;
  return (
    <span
      style={{
        ...TEXT.xs,
        color: note.severity === "critical" ? SEVERITY_COLOR.critical : COLOR.textDim,
      }}
      title={note.detail}
    >
      {note.label}
    </span>
  );
}
