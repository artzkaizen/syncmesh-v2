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
  /** Fires after the ledger changed — a receipt landed or a correction marked a record. */
  readonly onChange: (listener: () => void) => () => void;
}

export interface OpenedOperations {
  readonly view: OperationsView;
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
  Object.assign(extras, { operations: deps.store });
  const opened = openOperations({
    engine: deps.engine,
    store: deps.store,
    self: deps.self,
    now: deps.now,
  });
  return { extras, view: opened.view, stop: opened.stop };
}

/**
 * Watches acknowledgements and turns each one into durable receipts: when a peer's cursors
 * cover more of this device's events, every newly covered operation gets a receipt row —
 * idempotently, so replays and restarts cannot double-count.
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
        return;
      }
  });
  const off = (): void => {
    offAck();
    offFold();
  };

  return {
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
