import type { Engine, StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { OperationRow, OperationStore, ReceiptRow } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";

import { corrections } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";

import type { HandleExtras } from "./handles.js";

/**
 * The durable side of a write's journey (book ch. 10): the record was written inside the
 * commit by the writer; this half turns acknowledged cursors into receipt rows and reads the
 * ledger back — after restart too, which is the point.
 */
export interface OperationsView {
  readonly get: (id: string) => Promise<Result<OperationRow | undefined, StoreFailure>>;
  readonly byEvent: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<OperationRow | undefined, StoreFailure>>;
  /** Every write of this device no peer has receipted yet, oldest first. */
  readonly unsettled: () => Promise<Result<readonly OperationRow[], StoreFailure>>;
  /** Who holds the event, and since when. Delivery, never approval. */
  readonly receiptsOf: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<readonly ReceiptRow[], StoreFailure>>;
  /**
   * Fires after the ledger changed — this device committed a write, a receipt landed, or a
   * correction marked a record. The local commit's notification comes with the fold rather than
   * with the insert, because the insert runs inside the write's own transaction: a listener that
   * read the ledger from there would see a row a rollback can still take away.
   */
  readonly onChange: (listener: () => void) => () => void;
}

export interface OpenedOperations {
  readonly view: OperationsView;
  /**
   * The store a writer must be given: the caller's rows, plus the notification a local commit
   * owes its listeners. Handing the bare store to a writer instead is how a record lands that
   * nothing watching the ledger ever hears about.
   */
  readonly store: OperationStore;
  readonly stop: () => void;
}

export interface WiredOperations {
  /** What every handle's writer needs threaded in ({@link HandleExtras}). */
  readonly extras: HandleExtras;
  readonly view?: OperationsView;
  readonly stop: () => void;
}

/** The whole ledger seam in one call: no store, no ledger — a mesh over a bare event store. */
export function wireOperations(deps: {
  readonly engine: Engine;
  readonly self: PeerId;
  readonly now: () => Temporal.Instant;
  readonly store?: OperationStore;
}): WiredOperations {
  const extras: HandleExtras = { now: deps.now };
  if (deps.store === undefined) return { extras, stop: () => undefined };
  const opened = openOperations({
    engine: deps.engine,
    store: deps.store,
    self: deps.self,
    now: deps.now,
  });
  Object.assign(extras, { operations: opened.store });
  return { extras, view: opened.view, stop: opened.stop };
}

/**
 * Watches acknowledgements and turns each one into durable receipts: when a peer's cursors
 * cover more of this device's events, every newly covered operation gets a receipt row —
 * idempotently, so replays and restarts cannot double-count.
 *
 * It also owns the writer's store ({@link OpenedOperations.store}), because a write this device
 * commits is a ledger change like any other and has to reach `onChange` the same way. Watching
 * folds alone cannot stand in for that: most folds write no record at all, and a listener told
 * about every one of them learns nothing about the ledger.
 */
export function openOperations(deps: {
  readonly engine: Engine;
  readonly store: OperationStore;
  readonly self: PeerId;
  readonly now: () => Temporal.Instant;
}): OpenedOperations {
  const { engine, store, self, now } = deps;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  /**
   * A record written inside a commit whose listeners have not heard about it yet. The writer
   * inserts it inside the engine's transaction, and the engine's fold notification is the first
   * moment after that transaction is real — so the record is counted here and announced there,
   * once per commit however many listeners are watching.
   */
  let unannounced = 0;
  const recording: OperationStore = {
    ...store,
    record: async (op) => {
      const written = await store.record(op);
      if (written.isOk()) unannounced += 1;
      return written;
    },
  };
  /** The commits recorded since the last fold, cleared as they are announced. */
  const announce = (): void => {
    if (unannounced === 0) return;
    unannounced = 0;
    changed();
  };

  const settle = (): void => {
    for (const [holder, cursors] of engine.acks()) {
      const through = cursors.get(self);
      if (through === undefined) continue;
      void store.acknowledge(holder, self, through, now().epochMilliseconds).then((written) => {
        // a failed receipt is evidence, not silence: the next acknowledgement retries it anyway
        if (written.isErr()) console.warn(`receipt for ${String(holder)} failed:`, written.error);
        else changed();
      });
    }
  };

  /** A folded `_corrections` row naming one of this device's writes marks its record superseded. */
  const overruled = (): void => {
    for (const row of corrections(engine)) {
      if (!row.event.startsWith(`${String(self)}-`)) continue;
      const parsed = parseEventId(row.event);
      if (parsed.isErr()) continue;
      // `by` is the `_corrections` row's own id — the record a UI opens for the full story
      const by = `${row.event}:${row.table}:${row.key}`;
      void store
        .correct(parsed.value.peerId, parsed.value.seqNum, by, row.reason)
        .then((marked) => {
          if (marked.isErr()) console.warn(`correction mark failed:`, marked.error);
          else changed();
        });
    }
  };

  settle(); // the acks a previous session already held, before any new one arrives
  overruled(); // and the corrections that folded while this ledger was closed
  const offAck = engine.onAcknowledge(settle);
  const offFold = engine.onFoldBatch((batch) => {
    for (const table of batch.writeTables)
      if (String(table) === "_corrections") {
        overruled();
        break;
      }
    announce();
  });
  const off = (): void => {
    offAck();
    offFold();
  };

  return {
    store: recording,
    view: {
      get: (id) => store.get(id),
      byEvent: (peer, seq) => store.byEvent(peer, seq),
      unsettled: () => store.unsettled(),
      receiptsOf: (peer, seq) => store.receiptsOf(peer, seq),
      onChange: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    stop: () => {
      off();
      listeners.clear();
    },
  };
}
