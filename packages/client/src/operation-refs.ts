import type { StoreFailure } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { OperationRow, VouchRow } from "@syncmesh/storage";

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
  /** Fires when the record reads differently: the write committed, a vouch or a refusal landed, a correction marked it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a ref reads through: the row, who signed for it, and the announcement that either moved. */
export interface RefSource<E> {
  readonly get: (id: string) => Promise<Result<OperationRow | undefined, E>>;
  readonly vouchesOf: (peer: PeerId, seq: SeqNum) => Promise<Result<readonly VouchRow[], E>>;
  readonly onChange: (listener: () => void) => () => void;
}

/** Whether two lists of rows agree, field by field, in order. */
const sameRows = <T>(held: readonly T[], read: readonly T[], fields: readonly (keyof T)[]) =>
  held.length === read.length &&
  held.every((row, at) => fields.every((field) => row[field] === read[at]?.[field]));

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
    sameRows(held.refusals ?? [], read.refusals ?? [], ["by", "reason", "verdict"]) &&
    sameRows(held.vouches, read.vouches, ["holder", "incarnation", "atMs"])
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
