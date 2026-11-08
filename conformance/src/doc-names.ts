/** The fixed names every doc vector is written against (RFC-0023 §13). */
import { parseAdapterId, type ColumnName, type RowKey, type TableName } from "@syncmesh/kernel";

/** The instant every doc vector's clock starts from, in epoch ms. */
export const T0 = 1_700_000_000_000;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed vector names; the rules for these brands live in the schema */
export const NOTES = "notes" as TableName;
export const N1 = "n1" as RowKey;
export const CONTENT = "content" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const LORO = parseAdapterId("loro@1").unwrap();
