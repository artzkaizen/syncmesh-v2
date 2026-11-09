import type { Coverage, StoredEvent } from "@syncmesh/engine";

import { trackCoverage } from "@syncmesh/engine";
import { isRelayable } from "@syncmesh/wire";

/**
 * What catch-up can actually hand over: a synced entry whose author's signature was stored. An
 * entry without one is dropped by `paged`, and a local one is out of `allSince`'s scope — so
 * counting either into the room's position would advertise a place the room can never serve
 * from. Any log the relay did not fill itself holds both (`StartRelayOptions.store`).
 */
export const servable = (entry: StoredEvent): boolean =>
  isRelayable(entry) && entry.event.local !== true;

/**
 * The room's position at open: the compaction floors, raised by every servable entry of the log
 * above them. Contiguous, and over the same entries catch-up serves: a MAX cursor over a hole is a
 * claim the room cannot take back, because every client asks for what is *above* the number it
 * was given.
 *
 * @param trimmed - What compaction removed before this open (`compactedBelow`): the start of each
 *   run, so an author whose log begins past its floor still has a cursor to advertise.
 */
export function roomCoverage(trimmed: Coverage, log: readonly StoredEvent[]) {
  const coverage = trackCoverage(trimmed);
  for (const entry of log) if (servable(entry)) coverage.note(entry.event);
  return coverage;
}
