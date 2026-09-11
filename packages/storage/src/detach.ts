import type { StoreFailure } from "@syncmesh/engine";
import type { Result as ResultType } from "@syncmesh/result";

import { Result, TaggedError } from "@syncmesh/result";

import type { ScopedStoreSet, StoreScope } from "./open-stores.js";

import { operationStore } from "./operation-store.js";

/**
 * The partition still holds intent no peer has receipted — detaching now would delete the only
 * copy. The refusal reports what is unsent; ship it, or `forget` explicitly if losing it is the
 * point (book ch. 13: forgetting stays a separate, destructive action).
 */
export class DetachRefused extends TaggedError("DetachRefused")<{
  readonly scope: string;
  /** Operation ids whose events no peer holds yet. */
  readonly unsent: readonly string[];
  message?: string;
}> {}

/**
 * Sheds one partition the way the architecture sheds everything — whole (book ch. 13): refuse
 * while unacknowledged local intent exists, otherwise close the scope's stores and hand the
 * file's deletion back to the caller, who is the one that knew where to put it. Re-attaching
 * later is a grant plus checkpoint and tail, converging like any newcomer.
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
    const unsettled = yield* Result.await(ledger.unsettled());
    if (unsettled.length > 0) {
      return Result.err(
        new DetachRefused({
          scope: String(scope),
          unsent: unsettled.map((op) => op.id),
          message: `${String(scope)} holds ${String(unsettled.length)} unsent write(s)`,
        }),
      );
    }
    await set.forget(scope);
    await options.remove?.();
    return Result.ok(undefined);
  });
}
