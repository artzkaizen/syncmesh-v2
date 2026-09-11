import type { StoreFailure } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";

import { Result } from "@syncmesh/result";

import type { ScopedStoreSet, StoreScope } from "./open-stores.js";

import { detachScope } from "./detach.js";

/**
 * Storage pressure sheds whole partitions (book ch. 13): the same gesture as leaving a scope,
 * never row eviction — a partial partition is the rejected projection wearing a storage hat.
 */
export interface StorageBudget {
  readonly maxBytes: number;
  /** `"suggest"` reports what could be shed; `"lru-idle"` sheds it, oldest-opened first. */
  readonly detach: "suggest" | "lru-idle";
}

export interface BudgetReport {
  /** Every open scope's bytes at the start of the sweep. */
  readonly bytes: number;
  readonly over: boolean;
  /** What was shed — or, in `"suggest"` mode, what could be. */
  readonly shed: readonly StoreScope[];
  /** Refused by the detach guard (unsent intent) or busy; never shed automatically. */
  readonly kept: readonly StoreScope[];
}

/**
 * One pass over the open scopes: measure, and shed least-recently-opened **idle** partitions
 * until the budget holds. A scope the guard refuses stays — unsent intent outranks disk
 * pressure, always — and `"suggest"` mode changes nothing at all.
 *
 * The platform facts stay the caller's: how big a scope's file is, whether anything is using
 * it, and how to delete it — the set knows none of those.
 */
export async function sweepBudget(
  set: ScopedStoreSet,
  budget: StorageBudget,
  platform: {
    readonly sizeOf: (scope: StoreScope) => Promise<number>;
    /** Nothing holds this scope right now — no live query, no open screen. */
    readonly isIdle: (scope: StoreScope) => boolean;
    readonly remove: (scope: StoreScope) => Promise<void>;
  },
): Promise<ResultType<BudgetReport, StoreFailure>> {
  const scopes = set.opened();
  const sizes = new Map<StoreScope, number>();
  for (const scope of scopes) sizes.set(scope, await platform.sizeOf(scope));
  const bytes = [...sizes.values()].reduce((held, size) => held + size, 0);

  const shed: StoreScope[] = [];
  const kept: StoreScope[] = [];
  let remaining = bytes;
  for (const scope of scopes) {
    if (remaining <= budget.maxBytes) break;
    if (!platform.isIdle(scope)) {
      kept.push(scope);
      continue;
    }
    if (budget.detach === "suggest") {
      shed.push(scope);
      remaining -= sizes.get(scope) ?? 0;
      continue;
    }
    const detached = await detachScope(set, scope, { remove: () => platform.remove(scope) });
    if (detached.isErr()) {
      // unsent intent outranks disk pressure, always; anything else ends the sweep as itself
      if (detached.error._tag !== "DetachRefused") return Result.err(detached.error);
      kept.push(scope);
      continue;
    }
    shed.push(scope);
    remaining -= sizes.get(scope) ?? 0;
  }

  return Result.ok({ bytes, over: bytes > budget.maxBytes, shed, kept });
}
