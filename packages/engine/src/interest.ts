import type { JsonObject, JsonValue, PartitionKey, RowRecord, SyncEvent } from "@syncmesh/kernel";

import { isJsonArray, jsonObject, parsePartitionKey } from "@syncmesh/kernel";
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
 *
 * The one exception is a {@link InterestWindow}, and it is a snapshot's alone: a device that
 * joined under one holds the newest rows of a partition, and may hold a row outside them in part
 * (see `window`). It claims no coverage for what it serves, so the subset never spreads as whole.
 */
export interface Interest {
  /** Only these instances. Absent, every instance the policy already allows. */
  readonly partitions?: readonly PartitionKey[];
  /**
   * Only the newest rows of the slice, for a snapshot (RFC-0019 §3): what a device that renders
   * one screen joins with. Absent, every row.
   *
   * A window narrows a snapshot and nothing else. Events are never windowed — every new event is
   * among the newest — and a relay, which folds nothing, serves the whole slice and names the
   * window in the coverage it hands back, the narrower claim. A coverage adopted under a window
   * claims nothing about the rows outside it, so dropping or growing the window later re-pages
   * them (D23).
   *
   * So a device under a window can hold a row **in part**: an update to a row outside its window
   * arrives like any event and folds onto nothing, leaving a visible row with only the patched
   * cells until the window widens or is dropped and the re-page brings the rest. Such a device is
   * not a source of whole rows, so it claims no coverage for any snapshot it serves (D23).
   */
  readonly window?: InterestWindow;
}

/**
 * How many rows a windowed snapshot carries: the `newest` live rows of its slice by each row's
 * newest stamp, plus every tombstone in the slice, so a device that already holds a row never
 * keeps it after its delete.
 *
 * @example
 * const interest = { partitions: [team], window: { newest: 2_000 } } satisfies Interest;
 */
export interface InterestWindow {
  /**
   * A positive whole number of live rows, at most `Number.MAX_SAFE_INTEGER`. Any other value is
   * no window at all — the wider request — in the text, the snapshot and every comparison
   * ({@link wholeWindow}), and the Rust reads it the same way.
   */
  readonly newest: number;
}

/** An interest with nothing in it: the sender filters nothing, which is the old behaviour exactly. */
export const EVERYTHING: Interest = {};

/**
 * The window a request may carry: `newest` a positive whole number this build counts exactly.
 * Anything else — `0`, a negative, a fraction, `NaN`, past 2^53 − 1 — is no window, the wider
 * request, whether the app built it or the wire carried it.
 */
export const wholeWindow = (window: { readonly newest?: unknown } | undefined) => {
  const newest = window?.newest;
  // SAFETY: `isSafeInteger` has just said it is a number, and a whole one
  return Number.isSafeInteger(newest) && (newest as number) > 0
    ? ({ newest: newest as number } satisfies InterestWindow)
    : undefined;
};

/**
 * An interest's fields in their one order — `partitions`, then `window` — so a TypeScript and a
 * Rust device write the same text for the same request, whatever order the app spelled it in. A
 * window that is not {@link wholeWindow} is left out.
 */
const canonical = (interest: Interest): Interest => {
  const window = wholeWindow(interest.window);
  return {
    ...(interest.partitions !== undefined && { partitions: interest.partitions }),
    ...(window !== undefined && { window }),
  };
};

/**
 * An interest as wire text. It is already JSON — a list and a window — so it travels as JSON
 * rather than earning a codec of its own, which also means a build that never reads the position
 * simply serves everything (D14's additive rule). Written in one key order (`partitions`,
 * `window`), so the same request is the same text in both runtimes.
 *
 * @example
 * interestText({ window: { newest: 50 }, partitions: [acme] }); // '{"partitions":["org:acme"],"window":{"newest":50}}'
 */
export const interestText = (interest: Interest | undefined): string =>
  interest === undefined ? "" : JSON.stringify(canonical(interest));

/** Some text as a JSON object, or `undefined` for empty text, junk, or JSON that is no object. */
const objectIn = (text: string | undefined): JsonObject | undefined => {
  if (text === undefined || text === "") return undefined;
  return Result.try({
    // SAFETY: `JSON.parse` yields JSON; `jsonObject` keeps it only when it is an object
    try: () => jsonObject(JSON.parse(text) as JsonValue),
    catch: () => undefined,
  }).unwrapOr(undefined);
};

/* oxlint-disable anti-slop/no-runtime-typeof -- a partition list off the wire is an I/O boundary: its runtime shape is the fact being checked */
/** The partition keys a wire list holds; an element that is not one is dropped, as the Rust drops it. */
const partitionsIn = (list: readonly JsonValue[]): PartitionKey[] =>
  list.flatMap((item) =>
    typeof item === "string"
      ? parsePartitionKey(item)
          .map((key) => [key])
          .unwrapOr([])
      : [],
  );
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * The interest a parsed object holds, read exactly as the Rust's `interest_from` reads it:
 * `partitions` absent or `null` is every partition, a list keeps its partition keys, and anything
 * else is a request this build cannot read, so `undefined`. A window that is not
 * {@link wholeWindow} is dropped, the wider request.
 */
const readInterest = (object: JsonObject): Interest | undefined => {
  const listed = object["partitions"];
  if (listed !== undefined && listed !== null && !isJsonArray(listed)) return undefined;
  const window = wholeWindow(jsonObject(object["window"]));
  return {
    ...(isJsonArray(listed) && { partitions: partitionsIn(listed) }),
    ...(window !== undefined && { window }),
  };
};

/**
 * The interest some text carried, or `undefined` for text that named none. Junk is `undefined`
 * too, deliberately: an unreadable request must fall back to "everything the policy allows",
 * never to "nothing", which would silently starve a device rather than showing a bug. JSON that
 * is not an object, and a `partitions` that is not a list, are junk; a window this build cannot
 * read is dropped for the same reason: no window is the wider request.
 */
export const interestFrom = (text: string | undefined): Interest | undefined => {
  const object = objectIn(text);
  return object === undefined ? undefined : readInterest(object);
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
 * So does a **doc** change: it carries no cells a predicate could be evaluated against, and the
 * row it belongs to is what an interest selects.
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
  const window = wholeWindow(interest.window)?.newest;
  // a windowless key keeps its old text, so two builds that never window still agree on it
  return JSON.stringify(
    window === undefined ? [sorted(interest.partitions)] : [sorted(interest.partitions), window],
  );
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
  return within(next.partitions, previous.partitions) && windowWithin(next.window, previous.window);
}

const isEverything = (interest: Interest): boolean =>
  interest.partitions === undefined && wholeWindow(interest.window) === undefined;

/**
 * No window is every row, so it is the widest a window can be; a smaller count narrows. A window
 * that is not {@link wholeWindow} is no window.
 */
const windowWithin = (
  next: InterestWindow | undefined,
  previous: InterestWindow | undefined,
): boolean => {
  const asked = wholeWindow(next);
  const held = wholeWindow(previous);
  if (held === undefined) return true;
  if (asked === undefined) return false;
  return asked.newest <= held.newest;
};

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
  entitlement === undefined
    ? interestText(interest)
    : JSON.stringify({ ...canonical(interest ?? EVERYTHING), entitlement });

/** The two halves of a scope as {@link scopeText} wrote them; junk reads as no scope at all. */
export interface Scope {
  readonly interest: Interest | undefined;
  /** The entitlement the cursors were earned under; absent, the relay withheld nothing. */
  readonly entitlement: string | undefined;
}

/**
 * A scope's two halves back. An interest-only text — every scope written before D24 — reads as
 * `{ interest, entitlement: undefined }`, so a cursor scoped under the old rule keeps its meaning.
 * The entitlement is read whether or not the interest beside it is readable, as the Rust reads it.
 */
export const scopeFrom = (text: string | undefined): Scope => {
  const object = objectIn(text);
  if (object === undefined) return { interest: undefined, entitlement: undefined };
  const interest = readInterest(object);
  const named = object["entitlement"];
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a scope off the store is an I/O boundary: whether the entitlement is text is the fact being checked */
  const entitlement = typeof named === "string" ? named : undefined;
  // `{}` beside an entitlement is the relay writing back "no interest", not an interest of `{}`
  const asked =
    entitlement !== undefined && interest !== undefined && isEverything(interest)
      ? undefined
      : interest;
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
  const entries = await store.allSince(theirs, "synced", interest?.partitions);
  if (interest === undefined || entries.isErr()) return entries;
  return entries.map((all) => all.filter((entry) => matchesInterest(interest, entry.event)));
}

/**
 * What a device may be sent once its grant has had its say (D40): the partitions it asked for,
 * cut to the ones its grant names — or the grant's partitions whole when it asked for everything.
 *
 * The sender and the asker both compute this, from the same signed grant, so the scope a relay
 * stamps on a filtered catch-up is the scope the device joined with, byte for byte. Sorted, so a
 * cut applied twice — a join already cut to an older grant, cut again by the room's newer one —
 * spells the same text as one cut, which `interestText` compares.
 *
 * @example
 * ```ts
 * entitledInterest({ partitions: ["project:a", "project:b"] }, ["project:a"]);
 * // { partitions: ["project:a"] }
 * ```
 */
export function entitledInterest(
  interest: Interest | undefined,
  granted: readonly PartitionKey[],
): Interest {
  const asked = interest?.partitions;
  const kept = asked === undefined ? [...granted] : asked.filter((p) => granted.includes(p));
  const partitions = [...new Set(kept)].sort();
  // the cut is to partitions; a window asked for stays asked for, or the scope would claim more
  const window = wholeWindow(interest?.window);
  return window === undefined ? { partitions } : { partitions, window };
}

/**
 * Whether a grant lets its device read this event (D40): every event its partitions name, and
 * every unpinned one — an unpinned event is about the mesh rather than an instance, so no
 * partition list can be what keeps it out (D24).
 */
export const entitles = (granted: readonly PartitionKey[], event: SyncEvent): boolean =>
  event.partition === undefined || granted.includes(event.partition);
