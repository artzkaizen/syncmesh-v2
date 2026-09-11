import { useEffect, useState } from "react";

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
 * One write's durable record, as React state — after restart too, which is the point (book
 * ch. 10): the interesting states of a write outlive any call site, so a detail view looks the
 * operation up by id and re-reads when a receipt lands or a correction marks it.
 *
 * ```tsx
 * const op = useOperation(mesh.operations, operationId);
 * {op?.correction && <Overruled reason={op.correction.reason} />}
 * ```
 */
export function useOperation<O extends OperationRecord>(
  source: OperationSource<O> | undefined,
  id: string | undefined,
): O | undefined {
  const [record, setRecord] = useState<O | undefined>(undefined);

  useEffect(() => {
    if (source === undefined || id === undefined) {
      setRecord(undefined);
      return undefined;
    }
    let live = true;
    const read = (): void => {
      void source.get(id).then((held) => {
        if (live) setRecord(held.unwrapOr(undefined));
      });
    };
    read();
    const off = source.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, [source, id]);

  return record;
}
