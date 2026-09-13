import { useEffect, useRef, useState } from "react";

/** One durable operation record; `@syncmesh/client`'s `OperationRow` satisfies this structurally. */
export interface OperationRecord {
  readonly id: string;
  readonly label: string;
  readonly status: "applied" | "blocked" | "superseded";
  readonly correction?: { readonly by: string; readonly reason: string };
}

/** The ledger the record is read from; `mesh.operations` satisfies this structurally. */
export interface OperationSource<O extends OperationRecord> {
  readonly get: (
    id: string,
  ) => Promise<{ readonly unwrapOr: (fallback: O | undefined) => O | undefined }>;
  readonly onChange: (listener: () => void) => () => void;
}

/**
 * Whether two reads of the same record say the same thing, over the fields this hook declares.
 * The rest of an `OperationRow` — its author, sequence and timestamp — is fixed at the insert and
 * cannot move without one of these moving too.
 */
const unchanged = (
  held: OperationRecord | undefined,
  read: OperationRecord | undefined,
): boolean => {
  if (held === undefined || read === undefined) return held === read;
  return (
    held.id === read.id &&
    held.label === read.label &&
    held.status === read.status &&
    held.correction?.by === read.correction?.by &&
    held.correction?.reason === read.correction?.reason
  );
};

/**
 * One write's durable record, as React state — after restart too, which is the point (book
 * ch. 10): the interesting states of a write outlive any call site, so a detail view looks the
 * operation up by id and re-reads when a receipt lands or a correction marks it.
 *
 * The id may name a write that has not committed yet. That is the case worth showing, and it
 * works: the ledger announces this device's own commits, so the record appears under a listener
 * that was waiting for it.
 *
 * ```tsx
 * const op = useOperation(mesh.operations, operationId);
 * {op?.correction && <Overruled reason={op.correction.reason} />}
 * ```
 *
 * Keyed on the id and on whether there is a ledger at all — never on the source object, which a
 * caller building one structurally (`{ get, onChange }`) rebuilds on every render. An effect that
 * depended on it re-read and re-subscribed per render, and since every read decodes a fresh row,
 * the state it set rendered again: a component that never stopped reading. A ledger swapped for a
 * different one under the same operation id is not a case that exists — the ids are uuids.
 */
export function useOperation<O extends OperationRecord>(
  source: OperationSource<O> | undefined,
  id: string | undefined,
): O | undefined {
  const [record, setRecord] = useState<O | undefined>(undefined);
  const latest = useRef(source);
  latest.current = source;
  const ready = source !== undefined;

  useEffect(() => {
    const ledger = latest.current;
    if (!ready || ledger === undefined || id === undefined) {
      setRecord(undefined);
      return undefined;
    }
    let live = true;
    const read = (): void => {
      void ledger.get(id).then((held) => {
        const found = held.unwrapOr(undefined);
        // the ledger announces every change to it, most of them another write's: a record that
        // reads the same keeps its identity, so an unrelated commit costs this view no render
        if (live) setRecord((shown) => (unchanged(shown, found) ? shown : found));
      });
    };
    read();
    const off = ledger.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, [ready, id]);

  return record;
}
