import { panic } from "@syncmesh/result";

import type { Columns } from "./table.js";
import type { Kinds, PartitionTree } from "./manifest.js";

import { parseColumnName, parseTableName } from "./names.js";
import { RESERVED, isPartition, type Partition } from "./partition.js";

/**
 * A presence topic: a cursor, a typing flag, who-is-here. Declared next to the tables because an
 * ephemeral value from a peer needs a shape for the same reason a row does — unvalidated, it is
 * an injection surface. Never stored, never in the log (D16).
 */
export interface PresenceEntry<P extends PartitionTree, C extends Columns = Columns> {
  /** The instance kind a value belongs to; `board` means one cursor set per board. */
  readonly partition: Kinds<P> | Partition;
  /** The value's columns, checked on send and on receive exactly as a row's are. */
  readonly of: C;
  /** How long a value stays live without being re-sent. Default 10_000. */
  readonly ttlMs?: number;
}

export type PresenceMap = Readonly<Record<string, Columns>>;

/** What a manifest declares under `presence:` — one entry per topic. */
export type PresenceBlock<P extends PartitionTree, PC extends PresenceMap> = {
  readonly [K in keyof PC]: PresenceEntry<P, PC[K]>;
};

/**
 * A presence topic as the schema holds it: its shape, where it lives, how long it lasts. The
 * kind is a plain string here — it was checked against the tree at definition, and every reader
 * downstream treats it as opaque.
 */
export interface PresenceTopic {
  readonly name: string;
  readonly partition: string;
  readonly columns: Columns;
  readonly ttlMs: number;
}

/** Topic declarations, validated the way tables are: a real kind, a real name, a usable shape. */
export function presenceTopics<P extends PartitionTree, PC extends PresenceMap>(
  block: PresenceBlock<P, PC> | undefined,
  parents: ReadonlyMap<string, string | undefined>,
  declare: (value: Partition) => string,
): readonly PresenceTopic[] {
  if (block === undefined) return [];
  return Object.entries(block).map(([name, entry]) => {
    if (parseTableName(name).isErr())
      panic(`presence ${name}: a topic name follows the table grammar`);
    // a topic announces *about* an instance, so a kind only presence names is still a kind this
    // manifest declares — collected here for the same reason a table's is
    const kind = isPartition(entry.partition) ? declare(entry.partition) : entry.partition;
    if (!isPartition(entry.partition) && !parents.has(kind) && !RESERVED.has(kind))
      panic(`presence ${name}: unknown partition kind "${String(kind)}"`);
    const columns = Object.keys(entry.of);
    if (columns.length === 0) panic(`presence ${name}: a topic needs at least one column`);
    for (const column of columns)
      if (parseColumnName(column).isErr())
        panic(`presence ${name}: "${column}" is not a column name`);
    return { name, partition: kind, columns: entry.of, ttlMs: entry.ttlMs ?? 10_000 };
  });
}
