import type { Engine, StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type {
  OperationRow,
  OperationStore,
  ReceiptRow,
  RefusalRow,
  VouchRow,
} from "@syncmesh/storage";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyReceipt, RefusalReceipt } from "@syncmesh/wire";

import { corrections } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";

import type { HandleExtras } from "./handles.js";
import type { OperationRef } from "./operation-refs.js";

import { operationRefs } from "./operation-refs.js";

export type { OperationRecord, OperationRef, RefSource } from "./operation-refs.js";
export { operationRefs } from "./operation-refs.js";

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
   * *nobody has this yet*, never *syncing…*, which would be a spinner that cannot stop — unless
   * the row carries `refusals` (D32), when it can say the stronger true thing: *peer 3f2a… refused
   * this (GrantStale)*, or for `unknown-table`/`unknown-kind`, *3f2a… is on an older build and
   * cannot read this yet* — never "refused". Learned over direct links only: a relay does not
   * carry refusals, as it does not carry receipts.
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
   * Which peers parked the event and signed for saying so, and why (D32) — information, never a
   * gate. Weigh by refuser, never by count: three older builds saying `unknown-table` is one fact.
   * A refuser that later signs custody of the event is no longer here.
   */
  readonly refusals: (
    peer: PeerId,
    seq: SeqNum,
  ) => Promise<Result<readonly RefusalRow[], StoreFailure>>;
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
  /** A verified refusal of one of this device's writes (D32), handed to the transports likewise. */
  readonly refused: (refusal: RefusalReceipt) => void;
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
  readonly refused?: (refusal: RefusalReceipt) => void;
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
  return {
    extras,
    view: opened.view,
    vouched: opened.vouched,
    refused: opened.refused,
    stop: opened.stop,
  };
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
        if (written.isErr()) console.warn(`receipt for ${holder} failed:`, written.error);
        else changed();
      });
    }
  };

  /**
   * Vouches and refusals touch the same rows — a vouch deletes the refusals it covers — so they
   * are written one after another, in arrival order: an async driver must not land a refusal
   * between a vouch's delete and its insert.
   */
  let custodyWrites = Promise.resolve();
  const inOrder = (write: () => Promise<void>): void => {
    // a write that throws is logged and does not stop the ones queued behind it
    custodyWrites = custodyWrites
      .then(write)
      .catch((cause: unknown) => console.warn("custody ledger write failed:", cause));
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
    inOrder(() =>
      store
        .vouch(
          receipt.holder,
          receipt.author,
          receipt.throughSeq,
          receipt.incarnation,
          receipt.issuedAt.epochMilliseconds,
        )
        .then((written) => {
          // evidence, not silence: the holder re-vouches on the next exchange either way
          if (written.isErr()) console.warn(`vouch for ${receipt.holder} failed:`, written.error);
          else changed();
        }),
    );
  };

  /**
   * One arriving refusal, made durable (D32). Verified and filtered to this device's own writes by
   * the transport; nothing here acts on it beyond the ledger row a screen reads.
   */
  const refused = (refusal: RefusalReceipt): void => {
    inOrder(() =>
      store
        .refuse(
          refusal.refuser,
          refusal.author,
          refusal.seq,
          { reason: refusal.reason, verdict: refusal.verdict },
          refusal.issuedAt.epochMilliseconds,
        )
        .then((written) => {
          // evidence, not silence: the refuser repeats it on the next exchange while it is parked
          if (written.isErr())
            console.warn(`refusal from ${refusal.refuser} failed:`, written.error);
          else changed();
        }),
    );
  };

  /** A folded `_corrections` row naming one of this device's writes marks its record superseded. */
  const overruled = (): void => {
    for (const row of corrections(engine)) {
      if (!row.event.startsWith(`${self}-`)) continue;
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
    refused,
    view: {
      get: refOf,
      byEvent: (peer, seq) => store.byEvent(peer, seq),
      unsettled: () => store.unsettled(),
      soleCustody: () => store.soleCustody(),
      receiptsOf: (peer, seq) => store.receiptsOf(peer, seq),
      vouchesOf: (peer, seq) => store.vouchesOf(peer, seq),
      refusals: (peer, seq) => store.refusals(peer, seq),
      onChange,
    },
    stop: () => {
      off();
      listeners.clear();
    },
  };
}
