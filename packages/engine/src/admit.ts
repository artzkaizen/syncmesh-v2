import type { PeerId } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { Quarantined } from "./engine.js";
import type { EventStore, StoredEvent } from "./store.js";
import type { StateLookup, Validator } from "./validate.js";

interface AdmitDeps {
  readonly peerId: PeerId;
  readonly store: EventStore;
  readonly validate: Validator | undefined;
  readonly before: StateLookup;
  readonly quarantine: { readonly emit: (q: Quarantined) => void };
}

/** Drops own, duplicate and already-stored entries; quarantines what fails validation; returns the rest in order. */
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
      const verdict = deps.validate?.validate(event, deps.before);
      if (verdict !== undefined && verdict.isErr()) {
        quarantined++;
        deps.quarantine.emit({ event, reason: verdict.error });
        continue;
      }
      fresh.push(entry);
    }
    return Result.ok({ fresh, quarantined });
  });
