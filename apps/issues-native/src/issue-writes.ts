import type { Write } from "@syncmesh/orpc";

import { WORKSPACE_ID } from "@syncmesh/issues";
import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";

import { mesh } from "./device";

/** The write a screen is waiting to see, so the redraw that shows it can be timed. */
interface Pending {
  readonly what: string;
  readonly asked: number;
}

/**
 * Every write the issue screen makes, each one timed and each refusal put on screen.
 *
 * `committed` resolves to a `Result` and never rejects, so a refusal is a value to read and not a
 * throw to catch. Surfacing it is what makes the role model visible: sign in as a guest, press
 * something, and the rule says so in its own words.
 *
 * The timing splits "the write was slow" from "the screen was slow to show it", which feel
 * identical and have nothing to do with each other: `commit` is the engine appending and folding
 * locally, `visible` is the live query re-running and React drawing the result — which the screen
 * logs when it renders with `pending` set.
 */
export function useIssueWrites({
  account,
  attachedIds,
  id,
}: {
  readonly account: string;
  readonly attachedIds: ReadonlySet<string>;
  readonly id: string;
}) {
  const pending = useRef<Pending>(undefined);
  // the last write this screen made, followed by `Overruled` so the office's correction of it is
  // said out loud rather than only redrawn
  const [lastWrite, setLastWrite] = useState<string>();
  const attempt = useCallback((what: string, run: () => Write<unknown>) => {
    const asked = Date.now();
    pending.current = { what, asked };
    const write = run();
    setLastWrite(write.id);
    void write.committed.then((landed) => {
      if (landed.isErr()) {
        pending.current = undefined;
        Alert.alert(`${what} was refused`, landed.error.message);
        return;
      }
      // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
      console.log(`[write] ${what} · commit ${String(Date.now() - asked)}ms`);
    });
  }, []);

  const pickStatus = useCallback(
    (status: string) =>
      attempt("The status change", () =>
        // SAFETY: every key came from `STATUS_CHOICES`, which is the procedure's own enum
        mesh.api.issues.setStatus({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          status: status as never,
        }),
      ),
    [attempt, id, account],
  );
  const pickPriority = useCallback(
    (level: string) =>
      attempt("The priority change", () =>
        mesh.api.issues.edit({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          priority: Number(level),
        }),
      ),
    [attempt, id, account],
  );
  const pickAssignee = useCallback(
    (who: string) =>
      attempt("The assignment", () =>
        mesh.api.issues.assign({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          // the empty key is "nobody", which the procedure takes as an explicit null
          assigneeId: who === "" ? null : who,
        }),
      ),
    [attempt, id, account],
  );
  const pickLabel = useCallback(
    (labelId: string) => {
      const on = attachedIds.has(labelId);
      attempt(on ? "Removing the label" : "Adding the label", () =>
        (on ? mesh.api.issueLabels.detach : mesh.api.issueLabels.attach)({
          workspaceId: WORKSPACE_ID,
          issueId: id,
          labelId,
          actorId: account,
        }),
      );
    },
    [attempt, attachedIds, id, account],
  );

  return { attempt, lastWrite, pending, pickAssignee, pickLabel, pickPriority, pickStatus };
}
