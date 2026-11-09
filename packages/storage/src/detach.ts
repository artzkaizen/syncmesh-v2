import type { StoreFailure } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";

import { Result, TaggedError } from "@syncmesh/result";

import type { ScopedStoreSet, StoreScope } from "./open-stores.js";

import { operationStore } from "./operation-store.js";

/**
 * The partition still holds writes no peer has signed for holding — detaching now could delete
 * the only copy. The refusal reports them; get them held (a peer or a relay room that signs
 * custody, D28), or `forget` explicitly if losing them is the point (book ch. 13: forgetting
 * stays a separate, destructive action).
 */
export class DetachRefused extends TaggedError("DetachRefused")<{
  readonly scope: string;
  /** Operation ids whose events no peer has signed for holding (`soleCustody`). */
  readonly unsent: readonly string[];
  message?: string;
}> {}

/**
 * Sheds one partition the way the architecture sheds everything — whole (book ch. 13): refuse
 * while this device is the sole custodian of any write in it, otherwise close the scope's stores
 * and hand the file's deletion back to the caller, who is the one that knew where to put it.
 * Re-attaching later is a grant plus checkpoint and tail, converging like any newcomer.
 *
 * The guard is `soleCustody()`, the signed tier (D28): a peer's cursor saying it has a write is
 * a claim, and a claim must not license a deletion. A write a peer only acknowledged still
 * refuses the detach until a holder signs a receipt for it under a live incarnation.
 */
export async function detachScope(
  set: ScopedStoreSet,
  scope: StoreScope,
  options: {
    /** Deletes the scope's file(s) after a clean close; local forgetting, never mesh deletion. */
    readonly remove?: () => Promise<void>;
  } = {},
): Promise<ResultType<void, DetachRefused | StoreFailure>> {
  return Result.gen(async function* () {
    const stores = yield* Result.await(set.storeFor(scope));
    const ledger = yield* Result.await(operationStore(stores.driver));
    const sole = yield* Result.await(ledger.soleCustody());
    if (sole.length > 0) {
      return Result.err(
        new DetachRefused({
          scope,
          unsent: sole.map((op) => op.id),
          message: `${scope} holds ${sole.length} write(s) no peer has signed for holding`,
        }),
      );
    }
    await set.forget(scope);
    await options.remove?.();
    return Result.ok(undefined);
  });
}
