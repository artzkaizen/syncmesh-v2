import type { EventId } from "@syncmesh/kernel";

import { TaggedError } from "@syncmesh/result";

/**
 * The hop's log was replaced while a write waited to be held by it (D42): the room said hello
 * under a new epoch. An ack from the old lineage is not durability in the new one, so the wait
 * ends here rather than carrying over. The write is untouched — it is in this device's own log and
 * the join re-offers it to the new log; ask `synced()` again to wait on that one.
 */
export class DurabilityLost extends TaggedError("DurabilityLost")<{
  readonly event: EventId;
  /** The lineage the wait began under. */
  expected: string;
  /** The lineage the hop announced instead. */
  actual: string;
  message: string;
}> {}
