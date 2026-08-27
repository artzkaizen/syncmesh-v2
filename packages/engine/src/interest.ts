import type { Change, PartitionKey, Row, SyncEvent, TableName } from "@syncmesh/kernel";
import type { PolicyNode } from "@syncmesh/policy";
import type { Result } from "@syncmesh/result";

import { evaluate } from "@syncmesh/policy";

import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Cursors } from "./sync.js";

/**
 * What a device wants, so a sender can drop the rest before it becomes bytes (E13). An interest
 * **narrows** and never widens: it is a request, not a permission, and it is applied after the
 * read policy has already decided what this device may see at all.
 */
export interface Interest {
  /** Only these instances. Absent, every instance the policy already allows. */
  readonly partitions?: readonly PartitionKey[];
  /** Only these tables. Absent, all of them. */
  readonly tables?: readonly TableName[];
  /** Only rows matching this predicate — the same node language a rule is written in. */
  readonly where?: PolicyNode;
}

/** An interest with nothing in it: the sender filters nothing, which is the old behaviour exactly. */
export const EVERYTHING: Interest = {};

/** No grant is consulted here: an interest asks about rows, never about who the caller is. */
const ROWLESS = { grant: { account: "", claims: {} }, roles: [] } as const;

const satisfies = (where: PolicyNode, row: Row): boolean => evaluate(where, { ...ROWLESS, row });

/** Every column a predicate names, so a change that touches one can be recognised as relevant. */
export function predicateColumns(node: PolicyNode, into = new Set<string>()): ReadonlySet<string> {
  if (node.kind === "rowIs") for (const column of Object.keys(node.where)) into.add(column);
  else if (node.kind === "compare" || node.kind === "isIn" || node.kind === "owner")
    into.add(node.column);
  else if (node.kind === "claimHas" || node.kind === "claimEquals") into.add(node.column);
  else if (node.kind === "any" || node.kind === "all")
    for (const inner of node.of) predicateColumns(inner, into);
  else if (node.kind === "not") predicateColumns(node.of, into);
  return into;
}

/**
 * Whether one change is worth sending under `where`. The three kinds are deliberately not
 * symmetrical:
 *
 * - a **delete** always matches, so a device is never stranded holding a row it cannot learn died;
 * - an **insert** matches when the row satisfies the predicate;
 * - an **update** matches when the patch satisfies it **or** touches a column the predicate names,
 *   so a row moving *out* of the interest is still visible as it leaves.
 *
 * Without that last clause a device would keep a row forever at the value it had when it stopped
 * matching — the stale-row hole that server-maintained views (E27) exist to close properly.
 */
const changeMatches = (change: Change, where: PolicyNode, named: ReadonlySet<string>): boolean => {
  if (change.kind === "delete") return true;
  if (change.kind === "insert") return satisfies(where, change.row);
  if (satisfies(where, change.patch)) return true;
  for (const column of change.patch.keys()) if (named.has(String(column))) return true;
  return false;
};

/**
 * Whether this event is worth sending. An event is atomic — there is no half of one — so it
 * travels when **any** of its changes is wanted. Partition and table are map lookups and settle
 * the common case; only `where` costs a predicate evaluation.
 */
export function matchesInterest(interest: Interest, event: SyncEvent): boolean {
  const { partitions, tables, where } = interest;
  if (partitions !== undefined) {
    const wanted = event.partition;
    if (wanted === undefined || !partitions.includes(wanted)) return false;
  }
  const named = where === undefined ? new Set<string>() : predicateColumns(where);
  return event.changes.some((change) => {
    if (tables !== undefined && !tables.includes(change.table)) return false;
    return where === undefined || changeMatches(change, where, named);
  });
}

/**
 * A stable identity for an interest, so two devices asking the same thing are one subscription
 * and a relay can tell "the same again" from "something new". Order-insensitive in the lists,
 * because `[a, b]` and `[b, a]` are the same request.
 */
export function interestKey(interest: Interest): string {
  const sorted = (values: readonly string[] | undefined) =>
    values === undefined ? null : [...values].map(String).sort();
  return JSON.stringify([
    sorted(interest.partitions),
    sorted(interest.tables),
    interest.where ?? null,
  ]);
}

/**
 * The events above `theirs` that the asker actually wants. The filter runs at the **sender**, so
 * an uninterested event never becomes bytes — the point of the whole feature.
 */
export async function eventsWanted(
  store: EventStore,
  theirs: Cursors,
  interest: Interest | undefined,
): Promise<Result<readonly StoredEvent[], StoreFailure>> {
  const entries = await store.allSince(theirs);
  if (interest === undefined || entries.isErr()) return entries;
  return entries.map((all) => all.filter((entry) => matchesInterest(interest, entry.event)));
}
