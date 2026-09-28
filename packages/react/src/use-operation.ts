import { useCallback, useRef, useSyncExternalStore } from "react";

/** One durable operation record; `@syncmesh/client`'s `OperationRecord` satisfies this structurally. */
export interface OperationRecord {
  readonly id: string;
  readonly label: string;
  readonly status: "applied" | "blocked" | "superseded";
  readonly correction?: { readonly by: string; readonly reason: string };
}

/**
 * A handle on one operation: `client.$operations.get(id)` is one, and a test can build one from
 * three fields. The record `status()` returns keeps its identity until it reads differently —
 * that is the ref's promise, and what lets this hook hand it straight to React.
 */
export interface OperationRef<O extends OperationRecord> {
  readonly id: string;
  readonly status: () => O | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

const NOTHING = (): (() => void) => () => undefined;

/**
 * One write's durable record, as React state — after restart too, which is the point (book
 * ch. 10): the interesting states of a write outlive any call site, so a detail view holds the
 * operation's ref and re-renders when a receipt lands or a correction marks it.
 *
 * The ref may name a write that has not committed yet. That is the case worth showing, and it
 * works: the ledger announces this device's own commits, so the record appears under a ref that
 * was waiting for it.
 *
 * ```tsx
 * const op = useOperation(operationId ? client.$operations.get(operationId) : undefined);
 * {op?.correction && <Overruled reason={op.correction.reason} />}
 * ```
 *
 * Keyed on the ref's id, never on the ref object: `get(id)` hands back one object per id while
 * anything subscribes to it, but a caller building a ref structurally rebuilds it every render,
 * and a subscription keyed on that would be taken and dropped per render.
 */
export function useOperation<O extends OperationRecord>(
  ref: OperationRef<O> | undefined,
): O | undefined {
  const latest = useRef(ref);
  latest.current = ref;
  const id = ref?.id;

  const subscribe = useCallback(
    (notify: () => void) =>
      id === undefined ? NOTHING() : (latest.current?.subscribe(notify) ?? NOTHING()),
    [id],
  );
  const read = useCallback(() => (id === undefined ? undefined : latest.current?.status()), [id]);
  return useSyncExternalStore(subscribe, read, read);
}
