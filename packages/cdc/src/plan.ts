import type { Change, PartitionKey, RowKey, TableName } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { CaptureError } from "./errors.js";
import type { ChangeMapping, ChangeMappings } from "./mapping.js";
import type { ChangeMessage, SourceRow } from "./source.js";

import { TruncateRefused } from "./errors.js";
import { meshCells, meshKey, partitionOf, rowKey } from "./mapping.js";

/** One partition's share of a transaction: exactly the changes one signed event will carry. */
export interface PlannedEvent {
  readonly partition: PartitionKey;
  readonly changes: readonly Change[];
}

/** What the engine already holds, for the two messages that cannot say it themselves. */
export interface HeldRows {
  /** The instance a row was born in. A delete carries no row, so its instance can only be read. */
  readonly partitionOf: (table: TableName, key: RowKey) => PartitionKey | undefined;
  /** Every live key of a collection, for the one message that is table-wide: `truncate`. */
  readonly liveKeys: (table: TableName) => readonly RowKey[];
}

export interface PlanDeps {
  readonly mappings: ChangeMappings;
  readonly held: HeldRows;
  /** How many rows one `truncate` may tombstone. Absent, `truncate` is refused outright. */
  readonly truncateLimit?: number;
}

/** A row's net effect across the transaction: whether it was born in it, and the last word on it. */
interface Touch {
  readonly table: string;
  readonly mapping: ChangeMapping;
  readonly key: RowKey;
  /** First touch was an insert: this peer held no row before the transaction, so a net delete has nothing to tombstone. */
  readonly born: boolean;
  /**
   * A delete happened before the last write. The row the database now holds is a *new* one, so
   * the change is an insert even though the mesh still holds the old record — an update would
   * carry only the columns the new row named and leave every other one at the deleted row's
   * value, which is a database and a mesh that disagree forever with nothing left to correct it.
   */
  readonly recreated: boolean;
  readonly last: Extract<ChangeMessage, { t: "insert" | "update" | "delete" }>;
}

/**
 * One transaction's messages as the changes each partition's event will carry.
 *
 * **At most one change per row.** One event carries one stamp for every change in it, so a
 * delete and a write of the same key in one event would land on the same stamp and merge to
 * invisible — a row the database says exists, gone on every device, permanently. So a
 * transaction says what it did to each row once: its net effect, in first-touch order.
 *
 * The plan is a pure function of the messages and of what this peer holds, with no clock in it.
 * That is what makes a replay after a crash converge instead of diverge: the same transaction
 * from the same state plans the same changes, and the same values under later stamps are what
 * field-level LWW joins to the same answer on every peer.
 */
export function planTransaction(
  deps: PlanDeps,
  messages: readonly ChangeMessage[],
): Result<readonly PlannedEvent[], CaptureError> {
  const net = netOf(deps, messages);
  if (net.isErr()) return Result.err(net.error);
  const { touched, truncated } = net.value;

  const grouped = new Map<PartitionKey, Change[]>();
  const tombstones = plannedTruncates(deps, truncated, touched);
  if (tombstones.isErr()) return Result.err(tombstones.error);
  for (const [partition, change] of tombstones.value) place(grouped, partition, change);
  for (const touch of touched.values()) {
    const planned = plannedTouch(deps, touch);
    if (planned.isErr()) return Result.err(planned.error);
    if (planned.value !== undefined) place(grouped, planned.value[0], planned.value[1]);
  }
  // sorted, so which event carries the watermark follows from the transaction and not from the
  // order a hash map happened to hand back
  return Result.ok(
    [...grouped.keys()]
      .sort()
      .map((partition) => ({ partition, changes: grouped.get(partition) ?? [] })),
  );
}

/** What the transaction did to each row, and which tables it emptied, in message order. */
interface Net {
  readonly touched: ReadonlyMap<string, Touch>;
  readonly truncated: ReadonlySet<string>;
}

/**
 * The messages folded to one entry per row, first-touch order preserved. Tables nobody published
 * are dropped here rather than later, which is what "one direction per table" means in practice:
 * a table absent from the mapping never leaves the database at all.
 */
function netOf(deps: PlanDeps, messages: readonly ChangeMessage[]): Result<Net, CaptureError> {
  const touched = new Map<string, Touch>();
  const truncated = new Set<string>();
  for (const message of messages) {
    if (message.t === "begin" || message.t === "commit" || message.t === "schema") continue;
    const mapping = deps.mappings[message.table];
    if (mapping === undefined) continue;
    if (message.t === "truncate") {
      truncated.add(message.table);
      // rows written before the truncate are wiped by it; rows written after it survive, which
      // is also what keeps a tombstone and a re-insert of one key out of the same event
      for (const [id, touch] of touched) if (touch.table === message.table) touched.delete(id);
      continue;
    }
    const key =
      message.t === "insert"
        ? meshKey(mapping.collection, message.row)
        : Result.ok<RowKey, CaptureError>(rowKey(message.key));
    if (key.isErr()) return Result.err(key.error);
    const id = `${message.table} ${String(key.value)}`;
    touched.set(id, restated(touched.get(id), message, mapping, key.value));
  }
  return Result.ok({ touched, truncated });
}

/**
 * One row's running net effect with this message folded into it — where the two flags a later
 * message cannot recompute are carried forward.
 *
 * `born` is the **first** word on the row and never moves: it says this peer held nothing before
 * the transaction, which is what makes a net delete nothing to tombstone. `recreated` is the
 * opposite question and can only be answered here, because by the time the plan sees the last
 * message the delete that came before it is gone.
 */
function restated(
  before: Touch | undefined,
  message: Extract<ChangeMessage, { t: "insert" | "update" | "delete" }>,
  mapping: ChangeMapping,
  key: RowKey,
): Touch {
  return {
    table: message.table,
    mapping,
    key,
    born: before?.born ?? message.t === "insert",
    recreated: before !== undefined && (before.recreated || before.last.t === "delete"),
    last: message,
  };
}

const place = (grouped: Map<PartitionKey, Change[]>, partition: PartitionKey, change: Change) => {
  const changes = grouped.get(partition);
  if (changes === undefined) grouped.set(partition, [change]);
  else changes.push(change);
};

/**
 * A row's net effect as one change, or as nothing at all. Born and gone inside one transaction
 * is nothing: the mesh never saw the row, so a tombstone for it would be a record invented here
 * rather than one the database ever had.
 *
 * A write is an **insert** whenever the row the database now holds is new — born here, or
 * deleted and re-created here. Only a row that survived the transaction untouched by a delete is
 * an update, because only then are the columns this change leaves out still the row's own.
 */
function plannedTouch(
  deps: PlanDeps,
  touch: Touch,
): Result<readonly [PartitionKey, Change] | undefined, CaptureError> {
  const { collection } = touch.mapping;
  const { key, last } = touch;
  if (last.t === "delete") {
    if (touch.born) return Result.ok(undefined);
    // a delete carries no row, so the instance the engine holds is the only answer there is —
    // and a row this peer never held has nothing to tombstone and nowhere to file it
    const partition = deps.held.partitionOf(collection.name, key);
    if (partition === undefined) return Result.ok(undefined);
    return Result.ok([partition, { kind: "delete", table: collection.name, key }]);
  }
  const row: SourceRow = last.t === "insert" ? last.row : last.after;
  const partition = partitionOf(touch.table, key, touch.mapping, row);
  if (partition.isErr()) return Result.err(partition.error);
  const cells = meshCells(collection, row);
  const change: Change =
    touch.born || touch.recreated
      ? { kind: "insert", table: collection.name, key, row: cells }
      : { kind: "update", table: collection.name, key, patch: cells };
  return Result.ok([partition.value, change]);
}

/**
 * A `truncate` as what it actually is: one tombstone per row this peer holds, filed in the
 * instance each row was born in. Capped, and refused rather than trimmed — half a truncate is a
 * mesh that disagrees with the database about which rows survived, which is worse than a stop.
 */
function plannedTruncates(
  deps: PlanDeps,
  truncated: ReadonlySet<string>,
  touched: ReadonlyMap<string, Touch>,
): Result<readonly (readonly [PartitionKey, Change])[], CaptureError> {
  const planned: (readonly [PartitionKey, Change])[] = [];
  for (const table of truncated) {
    const mapping = deps.mappings[table];
    if (mapping === undefined) continue;
    const name = mapping.collection.name;
    const keys = deps.held.liveKeys(name).filter((key) => !touched.has(`${table} ${String(key)}`));
    const limit = deps.truncateLimit ?? 0;
    if (keys.length > limit) {
      return Result.err(
        new TruncateRefused({
          table,
          rows: keys.length,
          limit,
          message:
            deps.truncateLimit === undefined
              ? `truncate on ${table} needs an explicit truncateLimit`
              : `truncate on ${table} would tombstone ${keys.length} rows, over a cap of ${limit}`,
        }),
      );
    }
    for (const key of keys) {
      const partition = deps.held.partitionOf(name, key);
      if (partition !== undefined) planned.push([partition, { kind: "delete", table: name, key }]);
    }
  }
  return Result.ok(planned);
}
