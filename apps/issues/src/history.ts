import type { Handle } from "@syncmesh/client";
import type { Temporal } from "@syncmesh/temporal";

import type { ActivityKind } from "./domain.js";

import { activity } from "./tables.js";
import { at } from "./time.js";

/**
 * One line of an issue's history.
 *
 * Written by the handler that made the change, inside the same transaction, so the fact and the
 * record of it become one event and no device can ever hold one without the other. Deriving the
 * feed from the log instead was the alternative and is worse in the way that matters: the log
 * knows which *cells* moved, a person wants the sentence, and a device that joined last week
 * has had the events before that compacted away while the feed still has to render them.
 *
 * `fromValue` and `toValue` are text for every kind, including the numeric ones. A history row
 * is read, never computed with, and one nullable text column that always means "what it said
 * before" is easier to render than four typed columns of which three are always null.
 */
export interface Change {
  readonly issueId: string;
  readonly actorId: string;
  readonly kind: ActivityKind;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly when: Temporal.Instant;
}

export const record = async (mesh: Handle, change: Change): Promise<void> => {
  await mesh.db.insert(activity).values({
    id: crypto.randomUUID(),
    issueId: change.issueId,
    actorId: change.actorId,
    kind: change.kind,
    fromValue: change.from ?? null,
    toValue: change.to ?? null,
    at: at(change.when),
  });
};
