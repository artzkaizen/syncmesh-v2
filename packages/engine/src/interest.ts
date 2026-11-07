import type { PartitionKey, RowRecord, SyncEvent } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Cursors } from "./sync.js";

/**
 * What a device wants, so a sender can drop the rest before it becomes bytes. An interest
 * **narrows** and never widens: it is a request, not a permission, and it is applied after the
 * read policy has already decided what this device may see at all.
 *
 * **Partitions, and nothing finer** (book ch. 3). The table and row filters that used to live
 * here are gone, and not as a simplification: a filtered projection of a log does not fold to
 * identical state, so a device that folds may not hold a subset of a partition it claims — that
 * is a NEVER, and narrowing below the partition was it wearing transport clothes. What stays is
 * **transfer narrowing**: asking for some granted partitions now and others later, which shapes
 * which bytes travel and never what this device holds.
 */
export interface Interest {
  /** Only these instances. Absent, every instance the policy already allows. */
  readonly partitions?: readonly PartitionKey[];
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

/**
 * Whether one stored row falls inside an interest — the same narrowings the wire filter applies
 * to events, asked of state instead. Shared so a digest, a snapshot and the sender all agree on
 * what "the same slice" means; three answers here would be three kinds of false alarm.
 */
export function rowsIn(record: RowRecord, interest: Interest | undefined): boolean {
  const partitions = interest?.partitions;
  if (partitions === undefined) return true;
  const held = record.partition;
  // an unpinned row is in no instance, so a clause about instances says nothing about it (D24)
  return held === undefined || partitions.includes(held);
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
 * Sending it costs the asker one parked event it can retry later; dropping it at the sender would
 * put the event behind a scoped coverage that says it was accounted for, and nothing would ever
 * offer it again.
 */

/**
 * A stable identity for an interest, so two devices asking the same thing are one subscription
 * and a relay can tell "the same again" from "something new". Order-insensitive in the lists,
 * because `[a, b]` and `[b, a]` are the same request.
 */
export function interestKey(interest: Interest): string {
  const sorted = (values: readonly string[] | undefined) =>
    values === undefined ? null : [...values].map(String).sort();
  return JSON.stringify([sorted(interest.partitions)]);
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
  return within(next.partitions, previous.partitions);
}

const isEverything = (interest: Interest): boolean => interest.partitions === undefined;

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

/**
 * Whether one event is in the partitions the asker named.
 *
 * The whole of the filter now: an event belongs to exactly one instance, and an interest names
 * the instances this device wants bytes for. There is nothing to say about its tables or its
 * cells, because a device holds a partition entire or not at all (ch. 3).
 *
 * An **unpinned** event matches every interest (D24). It is about the mesh rather than about an
 * instance — a `global` row, an authority-visibility row — so *"only rows in these instances"*
 * says nothing about it, and two devices with different interests both receive it.
 */
export const matchesInterest = (interest: Interest | undefined, event: SyncEvent): boolean => {
  const partitions = interest?.partitions;
  if (partitions === undefined || event.partition === undefined) return true;
  return partitions.includes(event.partition);
};

/**
 * What a filtered catch-up's coverage is true for (D23, D24): the interest the device asked
 * with, and the entitlement the relay admitted it under. Absent `entitlement` is exactly
 * {@link interestText}, so a relay with no admission gate writes what it always wrote.
 *
 * @example
 * scopeText({ partitions: [acme] }, "clinic:a") // '{"partitions":["org:acme"],"entitlement":"clinic:a"}'
 */
export const scopeText = (interest: Interest | undefined, entitlement?: string): string =>
  entitlement === undefined ? interestText(interest) : JSON.stringify({ ...interest, entitlement });

/** The two halves of a scope as {@link scopeText} wrote them; junk reads as no scope at all. */
export interface Scope {
  readonly interest: Interest | undefined;
  /** The entitlement the cursors were earned under; absent, the relay withheld nothing. */
  readonly entitlement: string | undefined;
}

/**
 * A scope's two halves back. An interest-only text — every scope written before D24 — reads as
 * `{ interest, entitlement: undefined }`, so a cursor scoped under the old rule keeps its meaning.
 */
export const scopeFrom = (text: string | undefined): Scope => {
  // SAFETY: `scopeText` is the one writer of this key, and it writes a string or nothing; the
  // interest half is read exactly as `interestFrom` reads it
  const parsed = interestFrom(text) as (Interest & { readonly entitlement?: string }) | undefined;
  if (parsed === undefined) return { interest: undefined, entitlement: undefined };
  const { entitlement, ...interest } = parsed;
  // `{}` beside an entitlement is the relay writing back "no interest", not an interest of `{}`
  const asked =
    entitlement !== undefined && interest.partitions === undefined ? undefined : interest;
  return { interest: asked, entitlement };
};

/**
 * Whether two interests ask for the same slice, however they were spelled — `undefined` and
 * {@link EVERYTHING} are one request, and so are two partition lists in different orders.
 */
export const sameInterest = (a: Interest | undefined, b: Interest | undefined): boolean =>
  interestKey(a ?? EVERYTHING) === interestKey(b ?? EVERYTHING);

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
