import type { Reading, Source } from "@syncmesh/react";

/** The three words the pill can say. `local-ready` says nothing, which is the ordinary case. */
export type HealthWord = "Syncing…" | "Offline" | "Reconnecting…";

/** A medium that is configured and trying: a dial that failed, or a link it had that went away. */
const RETRYING: ReadonlySet<Source["condition"]> = new Set([
  "connecting-failed",
  "temporarily-unavailable",
]);

/**
 * One word for the header, from the reading `useStatus` gives.
 *
 * `catching-up` first: the mesh is carrying and the only news is that it has not finished. Then
 * a medium that is retrying, because *reconnecting* is the exact fact while a dial is being
 * retried and *offline* invites waiting for nothing. `offline` is left for a device whose media
 * are all in a condition a retry does not fix — radio off, no permission, no hardware. `opening`
 * and `blocked-recovery` say nothing: the first never reaches a screen under the provider, and
 * the second is an operator's screen, not a pill.
 */
export function healthWord(reading: Reading): HealthWord | undefined {
  if (reading.health === "catching-up") return "Syncing…";
  for (const source of reading.sources.values())
    if (RETRYING.has(source.condition)) return "Reconnecting…";
  if (reading.health === "offline") return "Offline";
  return undefined;
}
