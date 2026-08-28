export type {
  ChangeMessage,
  ChangeSource,
  ChangeStream,
  SourceRow,
  TableRead,
  Watermark,
} from "./source.js";
export { InvalidWatermark, compareWatermark, parseWatermark } from "./source.js";
export type { ChangeMapping, ChangeMappings } from "./mapping.js";
export { meshCells, meshKey, partitionOf } from "./mapping.js";
export type { CaptureError } from "./errors.js";
export {
  EventRefused,
  RowUnplaceable,
  RowUnreadable,
  SchemaDrift,
  SourceFailed,
  TruncateRefused,
} from "./errors.js";
export type { HeldRows, PlanDeps, PlannedEvent } from "./plan.js";
export { planTransaction } from "./plan.js";
export type { ApplyDeps } from "./apply.js";
export { applyPlan, heldRows, writeWatermark } from "./apply.js";
export { CDC_TABLE, storedWatermark, watermarkCells, watermarkKey } from "./watermark.js";
export type { CaptureOptions, CaptureReport, RunningCapture } from "./capture.js";
export { startCapture } from "./capture.js";
export type { BackfillDeps } from "./backfill.js";
export { runBackfill } from "./backfill.js";
export type { ManualChangeSource, ManualOptions, ManualTx } from "./manual.js";
export { manualChangeSource } from "./manual.js";
export type { CdcRules } from "./rules.js";
export { cdcAllow } from "./rules.js";
