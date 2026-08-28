import type { Brand } from "./primitives.js";
import type { CellValue, ColumnName } from "./record.js";

export type TableName = Brand<string, "TableName">;
export type RowKey = Brand<string, "RowKey">;

export type Row = ReadonlyMap<ColumnName, CellValue>;

export type Change =
  | { readonly kind: "insert"; readonly table: TableName; readonly key: RowKey; readonly row: Row }
  | {
      readonly kind: "update";
      readonly table: TableName;
      readonly key: RowKey;
      readonly patch: Row;
    }
  | { readonly kind: "delete"; readonly table: TableName; readonly key: RowKey }
  /**
   * A change a newer build wrote and this one has no fold for (D22-A), kept exactly as it
   * arrived so a later build can read what this one could not.
   *
   * **It never folds and never authors.** `unfoldableKind` refuses it at the fold and at the
   * probe, and `admit` parks it as `unknown-kind` — which is the point: the quarantine is keyed
   * by author and sequence, so a parked change has to know where in the run it sits or it cannot
   * hold the cursor open, and holding the cursor open is the whole reason for parking it.
   *
   * The union is no longer closed, and that is the price. What buys it back is that the
   * alternative does not work: a blob that cannot say which row it touches cannot be retried
   * against the table it belongs to, and cannot be shown to anyone asking what is parked.
   */
  | {
      readonly kind: "unknown";
      /** The wire tag this build did not recognise; a later one matches its own kinds against it. */
      readonly tag: number;
      readonly table: TableName;
      readonly key: RowKey;
      /** The payload as CBOR read it, untouched — this build understands none of its shape. */
      readonly data: unknown;
    };

/**
 * Everything this build knows how to fold: `Change` minus the opaque variant (D22-A). What every
 * fold, patch and projection takes, so the one shape they cannot handle cannot reach them by
 * accident — the check that rules it out is the same check that narrows the type.
 */
export type FoldableChange = Exclude<Change, { readonly kind: "unknown" }>;
