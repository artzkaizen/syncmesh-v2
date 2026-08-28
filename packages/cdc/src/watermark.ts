import type { Engine } from "@syncmesh/engine";
import type { CellValue, ColumnName, Row, RowKey } from "@syncmesh/kernel";

import { isVisible } from "@syncmesh/kernel";
import { cdcTable, scalarText } from "@syncmesh/schema";

import type { Watermark } from "./source.js";

import { rowKey } from "./mapping.js";
import { parseWatermark } from "./source.js";

/**
 * The watermark is **our** state, not the source's, so it lives where the rest of our state
 * does: a reserved row the authority signs, written in the same event as the last change it
 * covers. Kept anywhere else it can run ahead of an event that never landed, and a change the
 * source has already forgotten is a change nothing can ask for again.
 *
 * **The row is keyed by source, not by instance, and it rides whichever partition's event went
 * last.** That is deliberate, and it is worth being precise about who agrees on it. Two peers
 * holding the same events fold it by the ordinary stamp-ordered join and reach the same value,
 * so there is no order-dependent verdict here. A device holding only one instance's events sees
 * a row that lags — but only the authority ever reads this row, and the authority holds every
 * partition, so it converges exactly where it is read. Keying it per instance instead would pin
 * the resume point to the least recently written instance and replay the whole gap on every
 * restart, which is a cost paid forever to fix a staleness nobody observes.
 */
export const CDC_TABLE = cdcTable.name;

/** The row a source's position is filed under: the source's own name, one row per reader. */
export const watermarkKey = (source: string): RowKey => rowKey(source);

/**
 * Where this source was last read to, as the log holds it — `null` when it has never been read,
 * which is the resume that means "from the beginning, and backfill first if you were given a
 * reader". A cell that is not text is read as absent for the reason `_revocations` reads one
 * that way: it is a row this peer should not have folded, and guessing at it is worse.
 */
export function storedWatermark(engine: Engine, source: string): Watermark | null {
  const record = engine.state().get(CDC_TABLE)?.get(watermarkKey(source));
  if (record === undefined || !isVisible(record)) return null;
  const text = scalarText(record.cells.get(cdcTable.columnNames.watermark)?.value);
  return text === undefined ? null : parseWatermark(text).unwrapOr(null);
}

/** The `_cdc` row as cells, for the event that carries it. */
export const watermarkCells = (source: string, at: Watermark): Row =>
  new Map<ColumnName, CellValue>([
    [cdcTable.columnNames.id, source],
    [cdcTable.columnNames.watermark, String(at)],
  ]);
