import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { Quarantined } from "./engine.js";
import type { EngineError, ValidationError } from "./errors.js";
import type { QuarantineStore, UnknownHandling } from "./quarantine.js";
import type { EventStore, StoredEvent } from "./store.js";
import type { StateLookup, Validator } from "./validate.js";

import { unfoldableKind } from "./columns.js";
import { UnknownChangeKind } from "./errors.js";
import { UnreadableEvent, isUnknown, quarantineReason } from "./quarantine.js";

interface Hubs {
  readonly quarantine: { readonly emit: (q: Quarantined) => void };
  readonly errors: { readonly emit: (e: EngineError) => void };
}

export interface AdmitDeps extends Hubs {
  readonly peerId: PeerId;
  readonly store: EventStore;
  readonly validate: Validator | undefined;
  readonly before: StateLookup;
  readonly parked: QuarantineStore;
  readonly unknownHandling: UnknownHandling;
}

/**
 * A change kind no fold here understands, before anything reads its cells. Checked even with no
 * validator configured, because the crash it prevents is in the kernel and not in the ladder: a
 * fold reaches for `patch` on a change that has none and takes the whole batch down with it.
 */
const unfoldable = (event: SyncEvent): ValidationError | undefined => {
  for (const change of event.changes) {
    const kind = unfoldableKind(change);
    if (kind !== undefined) {
      return new UnknownChangeKind({
        table: String(change.table),
        kind,
        message: `this build has no fold for a ${kind} change`,
      });
    }
  }
  return undefined;
};

/**
 * Drops own, duplicate and already-stored entries; parks what fails, and returns the rest in
 * order.
 *
 * Parking is not folding and not storing: the event goes to the quarantine with the verdict this
 * build reached, and the author's cursor stops **below** it (D13). Advancing past a parked event
 * would be this device telling every peer it holds something it is still waiting to understand,
 * and no later exchange would ever offer it again.
 */
export const admit = (entries: readonly StoredEvent[], deps: AdmitDeps) =>
  Result.gen(async function* () {
    const fresh: StoredEvent[] = [];
    const seen = new Set<string>();
    let quarantined = 0;
    for (const entry of entries) {
      const { event } = entry;
      if (event.peerId === deps.peerId || seen.has(event.id)) continue;
      seen.add(event.id);
      if (yield* Result.await(deps.store.has(event.id))) continue;
      const verdict = unfoldable(event) ?? refusal(deps, event);
      if (verdict !== undefined) {
        quarantined++;
        park(deps, entry, verdict);
        continue;
      }
      fresh.push(entry);
    }
    return Result.ok({ fresh, quarantined });
  });

const refusal = (deps: AdmitDeps, event: SyncEvent): ValidationError | undefined => {
  const verdict = deps.validate?.validate(event, deps.before);
  return verdict !== undefined && verdict.isErr() ? verdict.error : undefined;
};

/**
 * Keeps the event and says so as loudly as the mesh asked to be told. `unknownHandling` moves
 * only the telling: every setting parks, and none of them folds, so two peers configured
 * differently still hold the same rows.
 */
const park = (deps: AdmitDeps, entry: StoredEvent, verdict: ValidationError): void => {
  const reason = quarantineReason(verdict);
  deps.parked.park({ entry, reason, verdict });
  const handling = isUnknown(reason) ? deps.unknownHandling : "warn";
  if (handling !== "ignore") deps.quarantine.emit({ event: entry.event, reason: verdict });
  if (handling === "fail") {
    deps.errors.emit(
      new UnreadableEvent({
        peer: entry.event.peerId,
        seqNum: entry.event.seqNum,
        reason,
        message: `parked (${reason}): ${verdict.message}`,
      }),
    );
  }
};
