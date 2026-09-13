import type { Result as ResultType } from "@syncmesh/result";
import type { OperationRow } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";

import { Result, TaggedError } from "@syncmesh/result";

import type { CallError, WriteResult } from "./api.js";

/**
 * A write is a statement, not a promise (book ch. 10).
 *
 * ```ts
 * client.products.create({ shopId, name: "Desk lamp", priceCents: 4900 });
 * // the whole call site — the live query shows the row, and its sync column tracks the journey
 * ```
 *
 * Deliberately **not** thenable, so the bare statement is the blessed form rather than a
 * floating-promise lint hit. The deeper reason is that a write's interesting states outlive any
 * call site: one made offline on Tuesday replicates on Thursday and may be corrected next month,
 * and a promise that resolved once cannot say any of that. What can is the durable record, which
 * this handle is a live view of.
 */
export interface Write<T> {
  /**
   * Allocated **before** the commit, so a caller that crashed mid-write can look up what it
   * started. An id a commit returned would be one an interrupted caller never saw.
   */
  readonly id: string;
  /**
   * The local, durable commit. Resolves to a `Result` and never rejects, which is what makes
   * ignoring it safe — a refusal is reported here and on telemetry either way.
   */
  readonly committed: Promise<ResultType<WriteResult<T>, CallError>>;
  /**
   * One milestone, bounded. A timeout ends this wait and nothing else: the write is untouched
   * and delivery carries on, which is why the error says `WaitExpired` rather than "failed".
   */
  readonly waitFor: (goal: Milestone) => Promise<ResultType<OperationRow, WaitError>>;
  /** The record as last read; `undefined` until the commit lands, and after that always a row. */
  readonly status: () => OperationRow | undefined;
  /** Fires when the record changed — a receipt landed, a correction displaced it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** A point on a write's journey worth awaiting (book ch. 10). */
export type Milestone =
  | { readonly milestone: "committed"; readonly within?: Temporal.Duration }
  | {
      readonly milestone: "replicated";
      /** Distinct peers that signed for it. Two copies on one host are one failure domain. */
      readonly remoteCopies: number;
      readonly within?: Temporal.Duration;
    };

/** The wait ended, not the write: it is still on its way, and asking again with longer is free. */
export class WaitExpired extends TaggedError("WaitExpired")<{
  readonly operationId: string;
  readonly milestone: string;
  message: string;
}> {}

/** The commit itself failed, so there is no journey to wait on. */
export class WaitUnreachable extends TaggedError("WaitUnreachable")<{
  readonly operationId: string;
  message: string;
}> {}

export type WaitError = WaitExpired | WaitUnreachable;

/**
 * The slice of a write ledger a binding needs, named structurally rather than imported.
 *
 * Structural because the ledger is not always the engine's own: a window that holds no engine
 * reads the origin's ledger across a port, and that reader fails in ways a `StoreFailure` cannot
 * name — the host's tab closed, or the mesh was built over a bare event store. Everything here
 * does the same thing with either, which is why the error arm is `Error` and not a union anybody
 * has to keep in step.
 */
export interface WriteLedger {
  readonly get: (id: string) => Promise<ResultType<OperationRow | undefined, Error>>;
  readonly receiptsOf: (
    peer: OperationRow["peer"],
    seq: OperationRow["seq"],
  ) => Promise<ResultType<readonly { readonly holder: string }[], Error>>;
  readonly onChange: (listener: () => void) => () => void;
}

export interface WriteDeps {
  readonly id: string;
  readonly committed: Promise<ResultType<WriteResult<unknown>, CallError>>;
  /** The ledger this write's record lives in; absent for a mesh that keeps none. */
  readonly ledger?: WriteLedger;
}

const DEFAULT_WAIT_MS = 30_000;

export function createWrite<T>(deps: WriteDeps): Write<T> {
  const listeners = new Set<() => void>();
  let held: OperationRow | undefined;

  const reread = async (): Promise<void> => {
    const row = await deps.ledger?.get(deps.id);
    if (row?.isOk() === true) held = row.value;
    for (const listener of listeners) listener();
  };
  // the commit is what first makes a record exist; everything after it arrives by subscription
  const first = deps.committed.then(reread, () => undefined);

  /**
   * The ledger subscription is refcounted rather than held for the handle's life. A write is a
   * statement an app makes and forgets — one subscription per write, kept forever, is the leak
   * `$inspect.handles()` exists to make loud, and taking it only while somebody is watching
   * costs nothing when nobody is.
   */
  let watchers = 0;
  let offLedger: (() => void) | undefined;
  const watch = (): (() => void) => {
    watchers += 1;
    offLedger ??= deps.ledger?.onChange(() => void reread());
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      watchers -= 1;
      if (watchers > 0) return;
      offLedger?.();
      offLedger = undefined;
    };
  };

  /** Distinct signed holders of this write, which is what `remoteCopies` counts. */
  const copies = async (): Promise<number> => {
    if (held === undefined || deps.ledger === undefined) return 0;
    const receipts = await deps.ledger.receiptsOf(held.peer, held.seq);
    if (receipts.isErr()) return 0;
    return new Set(receipts.value.map((receipt) => receipt.holder)).size;
  };

  const reached = async (goal: Milestone): Promise<boolean> => {
    if (held === undefined) return false;
    if (goal.milestone === "committed") return true;
    return (await copies()) >= goal.remoteCopies;
  };

  return {
    id: deps.id,
    // SAFETY: the api built this handle around its own call's result, whose data is T
    committed: deps.committed as Promise<ResultType<WriteResult<T>, CallError>>,
    status: () => held,
    subscribe: (listener) => {
      listeners.add(listener);
      const off = watch();
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    waitFor: async (goal) => {
      const settled = await deps.committed;
      if (settled.isErr()) {
        return Result.err(
          new WaitUnreachable({
            operationId: deps.id,
            message: `${deps.id} never committed: ${settled.error.message}`,
          }),
        );
      }
      await first;
      // `reached` is only true once `held` exists, so the record is in hand here
      if ((await reached(goal)) && held !== undefined) return Result.ok(held);

      const withinMs = goal.within?.total({ unit: "milliseconds" }) ?? DEFAULT_WAIT_MS;
      return new Promise<ResultType<OperationRow, WaitError>>((resolve) => {
        const release = watch();
        const onChange = (): void => {
          void reached(goal).then((there) => {
            if (!there || held === undefined) return;
            settle(Result.ok(held));
          });
        };
        const settle = (answer: ResultType<OperationRow, WaitError>): void => {
          clearTimeout(timer);
          listeners.delete(onChange);
          release();
          resolve(answer);
        };
        const timer = setTimeout(() => {
          // the wait ended, not the write: delivery carries on and asking again is free
          settle(
            Result.err(
              new WaitExpired({
                operationId: deps.id,
                milestone: goal.milestone,
                message: `${deps.id} has not reached ${goal.milestone} yet; delivery continues`,
              }),
            ),
          );
        }, withinMs);
        listeners.add(onChange);
      });
    },
  };
}
