import type { Change, PartitionKey, Row, RowRecord, SyncEvent, TableName } from "@syncmesh/kernel";
import type { PolicyNode } from "@syncmesh/policy";

import { evaluate } from "@syncmesh/policy";
import { Result } from "@syncmesh/result";

import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Cursors } from "./sync.js";

/**
 * What a device wants, so a sender can drop the rest before it becomes bytes. An interest
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

/**
 * An interest as wire text. It is already JSON — two lists and the policy AST — so it travels as
 * JSON rather than earning a codec of its own, which also means a build that never reads the
 * position simply serves everything (D14's additive rule).
 */
export const interestText = (interest: Interest | undefined): string =>
  interest === undefined ? "" : JSON.stringify(interest);

/**
 * The interest some text carried, or `undefined` for text that named none. Junk is `undefined`
 * too, deliberately: an unreadable request must fall back to "everything the policy allows",
 * never to "nothing", which would silently starve a device rather than showing a bug.
 */
export const interestFrom = (text: string | undefined): Interest | undefined => {
  if (text === undefined || text === "") return undefined;
  return Result.try({
    // SAFETY: parsed at the wire boundary and read only through Interest's own optional fields;
    // a predicate that is not a PolicyNode simply matches nothing when evaluated
    try: () => JSON.parse(text) as Interest,
    catch: () => undefined,
  }).unwrapOr(undefined);
};

/** No grant is consulted here: an interest asks about rows, never about who the caller is. */
const ROWLESS = { grant: { account: "", claims: {} }, roles: [] } as const;

const satisfies = (where: PolicyNode, row: Row): boolean => evaluate(where, { ...ROWLESS, row });

/**
 * Whether one stored row falls inside an interest — the same narrowings the wire filter applies
 * to events, asked of state instead. Shared so a digest, a snapshot and the sender all agree on
 * what "the same slice" means; three answers here would be three kinds of false alarm.
 */
export function rowsIn(record: RowRecord, interest: Interest | undefined): boolean {
  if (interest === undefined) return true;
  const { partitions, where } = interest;
  if (partitions !== undefined) {
    const held = record.partition;
    if (held === undefined || !partitions.includes(held)) return false;
  }
  if (where === undefined) return true;
  const row: Row = new Map([...record.cells].map(([column, cell]) => [column, cell.value]));
  return evaluate(where, { ...ROWLESS, row });
}

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
 * matching — the stale-row hole that server-maintained views exist to close properly.
 *
 * An **unknown** change matches, because nothing here can read its cells to say otherwise (D22-A).
 * So does a **doc** change: it carries no cells a predicate could be evaluated against, and the
 * row it belongs to is what an interest selects.
 * Sending it costs the asker one parked event it can retry later; dropping it at the sender would
 * put the event behind a scoped coverage that says it was accounted for, and nothing would ever
 * offer it again.
 */
const changeMatches = (change: Change, where: PolicyNode, named: ReadonlySet<string>): boolean => {
  if (change.kind === "delete" || change.kind === "unknown" || change.kind === "doc") return true;
  if (change.kind === "insert") return satisfies(where, change.row);
  if (satisfies(where, change.patch)) return true;
  for (const column of change.patch.keys()) if (named.has(String(column))) return true;
  return false;
};

/**
 * Whether this event is worth sending. An event is atomic — there is no half of one — so it
 * travels when **any** of its changes is wanted. Partition and table are map lookups and settle
 * the common case; only `where` costs a predicate evaluation.
 *
 * An **unpinned** event passes the partition test whatever instances are named (D24): it is about
 * no instance, so naming instances says nothing about it. A device that does not want it says so
 * with `tables`, which is the dimension that can express it.
 */
export function matchesInterest(interest: Interest, event: SyncEvent): boolean {
  const { partitions, tables, where } = interest;
  if (partitions !== undefined) {
    const wanted = event.partition;
    // an unpinned event is about no instance, so naming instances does not exclude it (D24). The
    // clause is "only rows in these instances", not "only rows that are in some instance and it
    // is one of these" — and reading it the second way is what made a `global` catalog, whose
    // whole promise is replication to every device, reach every device except the careful ones
    if (wanted !== undefined && !partitions.includes(wanted)) return false;
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
 * Whether `next` provably admits nothing `previous` did not — the test that lets a device keep a
 * scoped cursor through an interest change (D23).
 *
 * **Unsure answers `false`, and that asymmetry is the whole design.** A wrong `true` keeps a
 * cursor that claims events the new interest wants and the old one dropped, so they are skipped
 * for the life of the device and nothing ever says so. A wrong `false` costs one re-join. The
 * predicates are compared as written rather than reasoned about, so two spellings of the same
 * condition read as a change and pay that re-join — the cheap side of the trade.
 */
export function narrows(next: Interest | undefined, previous: Interest | undefined): boolean {
  // an unscoped cursor is already the stronger claim; nothing can widen past everything
  if (previous === undefined || isEverything(previous)) return true;
  if (next === undefined) return false;
  return (
    within(next.partitions, previous.partitions) &&
    within(next.tables, previous.tables) &&
    narrowsWhere(next.where, previous.where)
  );
}

const isEverything = (interest: Interest): boolean =>
  interest.partitions === undefined &&
  interest.tables === undefined &&
  interest.where === undefined;

/** `undefined` means "all of them", so it is the widest value a list can take, never the emptiest. */
const within = (
  next: readonly string[] | undefined,
  previous: readonly string[] | undefined,
): boolean => {
  if (previous === undefined) return true;
  if (next === undefined) return false;
  const allowed = new Set(previous.map(String));
  return next.every((value) => allowed.has(String(value)));
};

/** Adding a predicate narrows; dropping one widens; changing one is a question this does not answer. */
const narrowsWhere = (next: PolicyNode | undefined, previous: PolicyNode | undefined): boolean => {
  if (previous === undefined) return true;
  if (next === undefined) return false;
  return JSON.stringify(next) === JSON.stringify(previous);
};

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
