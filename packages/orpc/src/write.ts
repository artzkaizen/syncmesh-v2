import type { Result as ResultType } from "@syncmesh/result";
import type { OperationRow } from "@syncmesh/storage";

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
 *
 * **There is nothing here to await past the local commit, and that is the decision** (D27). A
 * `waitFor({ milestone: "replicated", remoteCopies: n })` stood here and asked the caller for a
 * number nobody at a call site can know: copies are not allocated by the app, they arrive because
 * a radio came up, and at the moment of the call the honest answer is almost always none. Its
 * bound expired without meaning anything — the write carried on unchanged — which is the mark of
 * a wait that should not exist. Who holds a write is read from the ledger when somebody asks, and
 * what gates a destructive action is `unsettled()` over the whole ledger, not a count of one.
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
  /** The record as last read; `undefined` until the commit lands, and after that always a row. */
  readonly status: () => OperationRow | undefined;
  /** Fires when the record changed — a receipt landed, a correction displaced it. */
  readonly subscribe: (listener: () => void) => () => void;
}

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
  readonly onChange: (listener: () => void) => () => void;
}

export interface WriteDeps {
  readonly id: string;
  readonly committed: Promise<ResultType<WriteResult<unknown>, CallError>>;
  /** The ledger this write's record lives in; absent for a mesh that keeps none. */
  /** Read when a record is, never at construction: a write made before the mesh opened has one later. */
  readonly ledger?: WriteLedger | undefined;
}

export function createWrite<T>(deps: WriteDeps): Write<T> {
  const listeners = new Set<() => void>();
  let held: OperationRow | undefined;

  const reread = async (): Promise<void> => {
    const row = await deps.ledger?.get(deps.id);
    if (row?.isOk() === true) held = row.value;
    for (const listener of listeners) listener();
  };
  // the commit is what first makes a record exist; everything after it arrives by subscription —
  // and a watcher who arrived before there was a ledger to watch is attached to it here
  void deps.committed.then(
    async () => {
      await reread();
      if (watchers > 0) offLedger ??= deps.ledger?.onChange(() => void reread());
    },
    () => undefined,
  );

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
  };
}
