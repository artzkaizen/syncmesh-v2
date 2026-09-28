import type { Engine, StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { OperationRow, OperationStore, ReceiptRow, VouchRow } from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyReceipt } from "@syncmesh/wire";

import { corrections } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";

import type { HandleExtras } from "./handles.js";

/**
 * One write's record (book ch. 10), built from what the ledger holds: the durable row, and who
 * signed for holding the event.
 */
export interface OperationRecord extends OperationRow {
  /**
   * Who signed for holding it, out of which store (D28) — delivery, never approval. A holder
   * that rebuilt its store since is no longer here. The book's `replication.receipts`.
   */
  readonly vouches: readonly VouchRow[];
}

/**
 * A handle on one operation by id (book ch. 10, D27): the same object for the same id while
 * anything holds it, readable now, subscribable — and awaitable for the store's own read of the
 * row, which is what `await ledger.get(id)` has always been. Each `await` is one read; nothing
 * runs at `get`.
 *
 * `status()` is `undefined` until a subscriber's first read lands and for an id no row carries;
 * the second is the case worth watching, because the ledger announces this device's commits and
 * the record appears under a listener that was waiting for it.
 */
export interface OperationRef<E = StoreFailure> extends Promise<
  Result<OperationRow | undefined, E>
> {
  readonly id: string;
  readonly status: () => OperationRecord | undefined;
  /** Fires when the record reads differently: the write committed, a vouch landed, a correction marked it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a ref reads through: the row, who signed for it, and the announcement that either moved. */
export interface RefSource<E> {
  readonly get: (id: string) => Promise<Result<OperationRow | undefined, E>>;
  readonly vouchesOf: (peer: PeerId, seq: SeqNum) => Promise<Result<readonly VouchRow[], E>>;
  readonly onChange: (listener: () => void) => () => void;
}

/**
 * The durable side of a write's journey (book ch. 10): the record was written inside the
 * commit by the writer; this half turns acknowledged cursors into receipt rows and reads the
 * ledger back — after restart too, which is the point.
 */
export interface OperationsView {
  readonly get: (id: string) => OperationRef;
  readonly byEvent: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<OperationRow | undefined, StoreFailure>>;
  /**
   * Every write of this device **nobody has told it they hold**, oldest first — the reading that
   * gates a destructive action (D27), and the honest words for it.
   *
   * Not "unsaved": the write is durable here the moment it commits. Not "unaccepted" either — a
   * peer holding an event is delivery and not approval. And a write some peer quarantined stays
   * here for good, because a parked event holds that peer's cursor below it and its
   * acknowledgement never rises to cover the refused write. So a screen built on this says
   * *nobody has this yet*, never *syncing…*, which would be a spinner that cannot stop.
   */
  readonly unsettled: () => Promise<Result<readonly OperationRow[], StoreFailure>>;
  /**
   * Who holds the event, and since when. Delivery, never approval.
   *
   * A holder here has **claimed** custody in its cursors, not signed for it: the signed path
   * exists (`transport/src/custody.ts`) and reaches nothing yet, so a row is a peer's word.
   * Enough to report; not yet enough to license an eviction — see D28.
   */
  readonly receiptsOf: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<readonly ReceiptRow[], StoreFailure>>;
  /**
   * Every write of this device **nobody has signed for**, oldest first (D28) — the reading that
   * may gate something destructive, and the only one that may.
   *
   * `unsettled` above is the weaker tier: a peer said in its cursors that it holds this. This one
   * is the stronger: a peer put its name and its storage lineage to holding it, and a peer that
   * rebuilt its store since is no longer counted.
   */
  readonly soleCustody: () => Promise<Result<readonly OperationRow[], StoreFailure>>;
  /** Who signed for the event, out of which store, and when. */
  readonly vouchesOf: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<readonly VouchRow[], StoreFailure>>;
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
   * A verified custody receipt for one of this device's writes: the far side has signed for
   * holding it. Handed to the transports, which is the only place a receipt arrives.
   */
  readonly vouched: (receipt: CustodyReceipt) => void;
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
  /** Absent for a mesh over a bare event store: nowhere to put a vouch, so none is asked for. */
  readonly vouched?: (receipt: CustodyReceipt) => void;
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
  return { extras, view: opened.view, vouched: opened.vouched, stop: opened.stop };
}

/** Whether two reads of one record say the same thing — the rest of a row is fixed at the insert. */
const sameRecord = (
  held: OperationRecord | undefined,
  read: OperationRecord | undefined,
): boolean => {
  if (held === undefined || read === undefined) return held === read;
  return (
    held.id === read.id &&
    held.label === read.label &&
    held.status === read.status &&
    held.correction?.by === read.correction?.by &&
    held.correction?.reason === read.correction?.reason &&
    held.vouches.length === read.vouches.length &&
    held.vouches.every(
      (vouch, at) =>
        vouch.holder === read.vouches[at]?.holder &&
        vouch.incarnation === read.vouches[at]?.incarnation &&
        vouch.atMs === read.vouches[at]?.atMs,
    )
  );
};

/**
 * Refs over a ledger, one live object per id.
 *
 * A ref costs nothing until subscribed: the first subscriber takes one listener on the ledger and
 * one read, however many components hold the ref, and the last one leaving gives both back. In
 * between, `get(id)` hands back the same object, which is what lets a hook key on it. Reads are
 * latest-wins — one out at a time, one more if the ledger moved meanwhile — so an older row can
 * never land after a newer one.
 */
export const operationRefs = <E>(source: RefSource<E>): ((id: string) => OperationRef<E>) => {
  const open = new Map<string, OperationRef<E>>();

  const openRef = (id: string): OperationRef<E> => {
    const watchers = new Set<() => void>();
    let record: OperationRecord | undefined;

    const read = async (): Promise<void> => {
      const row = await source.get(id);
      // evidence, not silence: the next announcement re-reads either way
      if (row.isErr()) return console.warn(`operation ${id} read failed:`, row.error);
      let next: OperationRecord | undefined;
      if (row.value !== undefined) {
        const vouches = await source.vouchesOf(row.value.peer, row.value.seq);
        if (vouches.isErr()) return console.warn(`vouches for ${id} read failed:`, vouches.error);
        next = { ...row.value, vouches: vouches.value };
      }
      if (sameRecord(record, next)) return;
      record = next;
      for (const watcher of watchers) watcher();
    };
    /** The read in flight, if one is; a refresh during it is remembered, and runs once it lands. */
    let reading: Promise<void> | undefined;
    let queued = false;
    const refresh = (): void => {
      queued = reading !== undefined;
      reading ??= read().finally(() => {
        reading = undefined;
        if (queued) refresh();
      });
    };

    let off: (() => void) | undefined;
    const ref: OperationRef<E> = {
      id,
      status: () => record,
      subscribe: (listener) => {
        watchers.add(listener);
        if (watchers.size === 1) {
          open.set(id, ref);
          off = source.onChange(refresh);
          refresh();
        }
        return () => {
          if (!watchers.delete(listener) || watchers.size > 0) return;
          off?.();
          off = undefined;
          open.delete(id);
        };
      },
      // a ref *is* awaitable for the store's read — `await ledger.get(id)` is the ledger's
      // one-shot read and has been since before the ref existed — and every consumption is one
      // read, so the promise is delegated per call rather than started at `get`
      /* oxlint-disable-next-line unicorn/no-thenable -- see above: the read surface is thenable by design (book ch. 9) */
      then: (onFulfilled, onRejected) => source.get(id).then(onFulfilled, onRejected),
      catch: (onRejected) => source.get(id).catch(onRejected),
      finally: (onFinally) => source.get(id).finally(onFinally),
      [Symbol.toStringTag]: "OperationRef",
    };
    return ref;
  };

  return (id) => open.get(id) ?? openRef(id);
};

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

  /**
   * One arriving vouch, made durable.
   *
   * The transport has already verified the signature and already dropped anything that was not
   * about this device's own log, so what reaches here is a fact about our writes: this holder,
   * out of this store, has these. `vouch` forgets the holder's older lineage before it records
   * the new one, which is how a peer that rebuilt stops counting for what it lost.
   */
  const vouched = (receipt: CustodyReceipt): void => {
    void store
      .vouch(
        receipt.holder,
        receipt.author,
        receipt.throughSeq,
        receipt.incarnation,
        receipt.issuedAt.epochMilliseconds,
      )
      .then((written) => {
        // evidence, not silence: the holder re-vouches on the next exchange either way
        if (written.isErr())
          console.warn(`vouch for ${String(receipt.holder)} failed:`, written.error);
        else changed();
      });
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
  const onChange = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const refOf = operationRefs({ get: store.get, vouchesOf: store.vouchesOf, onChange });

  return {
    store: recording,
    vouched,
    view: {
      get: refOf,
      byEvent: (peer, seq) => store.byEvent(peer, seq),
      unsettled: () => store.unsettled(),
      soleCustody: () => store.soleCustody(),
      receiptsOf: (peer, seq) => store.receiptsOf(peer, seq),
      vouchesOf: (peer, seq) => store.vouchesOf(peer, seq),
      onChange,
    },
    stop: () => {
      off();
      listeners.clear();
    },
  };
}
