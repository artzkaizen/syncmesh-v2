import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { Quarantined } from "./engine.js";
import type { EventStore } from "./store.js";
import type { RowLookup, Validator } from "./validate.js";

interface AdmitDeps {
  readonly peerId: PeerId;
  readonly store: EventStore;
  readonly validate: Validator | undefined;
  readonly before: RowLookup;
  readonly quarantine: { readonly emit: (q: Quarantined) => void };
}

/** Drops own, duplicate and already-stored events; quarantines what fails validation; returns the rest in order. */
export const admit = (events: readonly SyncEvent[], deps: AdmitDeps) =>
  Result.gen(async function* () {
    const fresh: SyncEvent[] = [];
    const seen = new Set<string>();
    let quarantined = 0;
    for (const event of events) {
      if (event.peerId === deps.peerId || seen.has(event.id)) continue;
      seen.add(event.id);
      if (yield* Result.await(deps.store.has(event.id))) continue;
      const verdict = deps.validate?.validate(event, deps.before);
      if (verdict !== undefined && verdict.isErr()) {
        quarantined++;
        deps.quarantine.emit({ event, reason: verdict.error });
        continue;
      }
      fresh.push(event);
    }
    return Result.ok({ fresh, quarantined });
  });
