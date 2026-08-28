import type { Brand } from "./primitives.js";
import type { Stamp } from "./stamp.js";

import { isJsonArray, jsonObject, type CellValue, type JsonValue } from "./record.js";

/** The id one add is tagged with. Globally unique, and the only thing a remove ever names. */
export type SetTag = Brand<string, "SetTag">;

/** One element entering the set, with the id that will outlive it as a tombstone. */
export interface SetAdd {
  readonly tag: SetTag;
  readonly value: JsonValue;
}

/**
 * An OR-Set cell: one entry per id ever added, holding `[element]` while the id is live and `[]`
 * once some peer removed it. A remove names ids and never values, which is the whole property —
 * an add that was concurrent with a remove survives, because the remove never saw its id.
 *
 * Dropping the element and keeping the bare id is also what bounds the cell: a re-delivered add is
 * emptied again on arrival rather than resurrected, and a churning set costs one id per removal
 * instead of every value it ever held.
 */
export type SetState = Readonly<Record<string, readonly JsonValue[]>>;

/* oxlint-disable anti-slop/no-runtime-typeof -- canonicalising a foreign JSON value dispatches on its runtime type */
/**
 * A JSON value as text with every object's keys sorted. Elements are compared by this and not by
 * `JSON.stringify`, whose output follows insertion order: the same element built by a local write
 * on one device and decoded from CBOR on another would otherwise compare unequal.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Reads a cell as OR-Set state, in one normal form: ids sorted, each holding at most one element.
 * Anything unreadable reads as the empty set — identically on every peer, which is the only way a
 * malformed write stays a malformed write rather than becoming a disagreement.
 */
export function readSet(value: CellValue | undefined) {
  const object = jsonObject(value);
  if (object === undefined) return {};
  const state: Record<string, readonly JsonValue[]> = {};
  for (const tag of Object.keys(object).sort()) {
    const entry = object[tag];
    if (isJsonArray(entry)) state[tag] = entry.length === 0 ? [] : [entry[0] ?? null];
  }
  return state;
}

/**
 * A removal is final, so the empty entry is the top of this lattice. Two live elements under one id
 * — only a peer that reused an id produces that — settle on the smaller canonical form: picking
 * "whichever side came first" would let two honest peers who merged the pair in different orders
 * disagree for good.
 */
const joinEntry = (
  left: readonly JsonValue[] | undefined,
  right: readonly JsonValue[] | undefined,
): readonly JsonValue[] => {
  if (left === undefined) return right ?? [];
  if (right === undefined) return left;
  if (left.length === 0 || right.length === 0) return [];
  return canonicalJson(left[0] ?? null) <= canonicalJson(right[0] ?? null) ? left : right;
};

/** Per id, the join of the two entries: every id either side knows, tombstoned if either side removed it. */
export function joinSets(a: CellValue, b: CellValue) {
  const left = readSet(a);
  const right = readSet(b);
  const state: Record<string, readonly JsonValue[]> = {};
  for (const tag of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
    state[tag] = joinEntry(left[tag], right[tag]);
  return state;
}

/** The live elements in id order, each once: what a `set` column reads as. */
export function setValue(value: CellValue | undefined): readonly JsonValue[] {
  const state = readSet(value);
  const seen = new Set<string>();
  const elements: JsonValue[] = [];
  for (const tag of Object.keys(state)) {
    const entry = state[tag] ?? [];
    if (entry.length === 0) continue;
    const element = entry[0] ?? null;
    const text = canonicalJson(element);
    if (seen.has(text)) continue;
    seen.add(text);
    elements.push(element);
  }
  return elements;
}

/**
 * Every id this peer has seen for `element` — exactly what a `remove` tombstones, and nothing more.
 * An add still in flight is not in here, which is why it survives the remove that crosses it.
 */
export function setTagsFor(value: CellValue | undefined, element: JsonValue): readonly SetTag[] {
  const state = readSet(value);
  const target = canonicalJson(element);
  // SAFETY: the keys of a read state are the ids it was built from, each already a SetTag
  return Object.keys(state).filter((tag) => {
    const entry = state[tag] ?? [];
    return entry.length > 0 && canonicalJson(entry[0] ?? null) === target;
  }) as SetTag[];
}

/**
 * A globally unique id for one add: the author's stamp, which no other peer can repeat, and the
 * add's index within the event, which separates two adds made in one transaction.
 */
export function setTag(stamp: Stamp, index: number): SetTag {
  // SAFETY: an HLC is unique per peer per event, and `index` separates adds within one event
  return `${stamp.hlc[0].epochMilliseconds}.${stamp.hlc[1]}.${index}@${stamp.peer}` as SetTag;
}
