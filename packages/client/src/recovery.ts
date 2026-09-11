import type { Engine, ReceiveReport, StoreFailure } from "@syncmesh/engine";
import type { EventId, PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

/**
 * What is stuck and why, as stable causes (book ch. 18): the quarantine's parked events read
 * back as issues an operator can act on. Recovery itself is automatic — a grant that lands
 * re-offers what it unblocks — so `run` is the idempotent nudge, never a discard.
 */
export interface RecoveryIssue {
  /**
   * `missing-capability`: the author's grant was absent, stale, revoked or too narrow — the
   * fix is a grant, and arrival wakes the event. `refused`: the event itself failed the
   * schema's rules; a later build (or policy) may read the same bytes differently.
   */
  readonly kind: "missing-capability" | "refused";
  readonly event: EventId;
  readonly author: PeerId;
  /** The verdict's tag — `NoGrant`, `GrantStale`, `PartitionNotGranted`, … */
  readonly verdict: string;
  readonly message: string;
}

export interface RecoveryView {
  readonly list: () => readonly RecoveryIssue[];
  /** Re-runs admission over everything parked; a no-op when nothing changed since it parked. */
  readonly run: () => Promise<Result<ReceiveReport, StoreFailure>>;
}

const CAPABILITY_VERDICTS = new Set([
  "NoGrant",
  "GrantStale",
  "GrantRevoked",
  "GrantDeviceMismatch",
  "PartitionNotGranted",
]);

export function openRecovery(engine: Engine): RecoveryView {
  return {
    list: () =>
      engine.quarantine().map(({ entry, verdict }) => ({
        kind: CAPABILITY_VERDICTS.has(verdict._tag) ? "missing-capability" : "refused",
        event: entry.event.id,
        author: entry.event.peerId,
        verdict: verdict._tag,
        message: verdict.message,
      })),
    run: () => engine.retryQuarantined(),
  };
}
