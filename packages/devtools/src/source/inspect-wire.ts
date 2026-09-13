/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-shape-in-symbol-names -- this file *is* the inspector's thread boundary: a `postMessage` hands over `unknown`, the read name is the parse, a serialized tagged error is a field bag until a catalog revives it, and `shape` here is the domain word — which of the contract's `| undefined` members this host actually has (`@syncmesh/result`'s wire.ts disables the same set for the same reason) */

import type { AnyTaggedError, Result as ResultType } from "@syncmesh/result";

import { StoreFailure } from "@syncmesh/engine";
import { Result, TaggedError, createTaggedCatalog, serializeTagged } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { DevtoolsChannel, DevtoolsSource } from "../contract.js";

import { QueryFailed, QueryRefused } from "../contract.js";
import { ControlRefused } from "../controls.js";

/**
 * The vocabulary a window and the tab holding the engine share, and the one thing they must
 * encode by hand.
 *
 * `DevtoolsSource` was designed so that every snapshot is plain data — that is the contract's
 * first rule, and it is what makes this file forty lines rather than a serialiser. The exception
 * is time: a `Temporal.Instant` is a class instance and no structured clone carries one, so the
 * instants are tagged on the way out and rebuilt on the way in. Nothing else is touched, because
 * nothing else needed to be.
 */

/** The readers a window caches, because each answers synchronously and a port cannot. */
export const SNAPSHOTS = [
  "identity",
  "overview",
  "sync",
  "links",
  "schema",
  "grants",
  "timings",
] as const;

export type SnapshotName = (typeof SNAPSHOTS)[number];

/** One reading of each cached surface; partial, because a window asks only for what it draws. */
export type Snapshot = {
  readonly [K in SnapshotName]?: unknown;
};

/**
 * Which `| undefined` members this host actually has.
 *
 * Asked once, at the prime, rather than guessed: `storage`, `writes` and `sql` are absent on a
 * mesh with no SQL door or no write ledger, and a panel renders that absence as a sentence. A
 * window that assumed they were there would draw an empty table over a mesh that keeps no ledger,
 * which is the one thing those `| undefined` arms exist to prevent.
 */
export interface InspectServed {
  readonly storage: boolean;
  readonly writes: boolean;
  readonly sql: boolean;
}

/** The prime: everything a freshly opened panel needs before it draws a frame. */
export interface Opened {
  readonly served: InspectServed;
  readonly snapshot: Snapshot;
}

/** A `Result` as it crosses: the class stays behind, the tag comes with it. */
export type Carried =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Record<string, unknown> };

/**
 * The inspector will not answer that read: no panel is open, the name is unknown, or this mesh
 * has no such surface.
 *
 * One error for the three because a window's whole response to any of them is the same — draw the
 * absence as a sentence — and because the *reason* travels in `message` where a reader can see it.
 */
export class InspectRefused extends TaggedError("InspectRefused")<{
  readonly read: string;
  message: string;
}> {}

/** The failures that cross an inspect read, revived on the window as the classes it declares. */
export const inspectFailures = createTaggedCatalog([
  InspectRefused,
  ControlRefused,
  QueryFailed,
  QueryRefused,
  StoreFailure,
]);

const INSTANT = "@syncmesh/instant";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

const mapValues = (value: Record<string, unknown>, walk: (inner: unknown) => unknown) =>
  Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));

/**
 * Every instant tagged, everything else left exactly as it was.
 *
 * `Map`, `Set`, `Uint8Array` and `Date` all cross a structured clone as themselves and none of
 * them holds an instant anywhere in this contract, so they are passed through untouched rather
 * than rebuilt — a walker that rewrote them would be inventing work and losing identity.
 */
export const plain = (value: unknown): unknown => {
  if (value instanceof Temporal.Instant) return { [INSTANT]: value.toString() };
  if (Array.isArray(value)) return value.map(plain);
  if (isPlainObject(value)) return mapValues(value, plain);
  return value;
};

export const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revive);
  if (!isPlainObject(value)) return value;
  const tagged = value[INSTANT];
  if (typeof tagged === "string") return Temporal.Instant.from(tagged);
  return mapValues(value, revive);
};

/** The seven cached readers, named once so both ends read the same list. */
export const SNAPSHOT_READERS = {
  identity: (source: DevtoolsSource) => source.identity(),
  overview: (source: DevtoolsSource) => source.overview(),
  sync: (source: DevtoolsSource) => source.sync(),
  links: (source: DevtoolsSource) => source.links(),
  schema: (source: DevtoolsSource) => source.schema(),
  grants: (source: DevtoolsSource) => source.grants(),
  timings: (source: DevtoolsSource) => source.timings(),
} satisfies Record<SnapshotName, (source: DevtoolsSource) => unknown>;

/** Which channels a cached reader answers for, so a window can re-announce a change it caught up to. */
export const SNAPSHOT_CHANNELS = {
  identity: ["auth", "grant"],
  overview: ["link", "fold", "quarantine"],
  sync: ["fold", "ack", "quarantine"],
  links: ["link", "route", "ack"],
  schema: [],
  grants: ["grant"],
  timings: ["fold"],
} satisfies Record<SnapshotName, readonly DevtoolsChannel[]>;

/** A `Result` on its way out: the value flattened, the failure reduced to its tag and fields. */
export const carry = <T>(outcome: ResultType<T, AnyTaggedError>): Carried =>
  outcome.isErr()
    ? { ok: false, error: serializeTagged(outcome.error) }
    : { ok: true, value: plain(outcome.value) };

/**
 * The same `Result` on the way in, with `whenLost` standing in for a port that died.
 *
 * A window can lose the tab holding the mesh in the middle of a read, and the contract's error
 * arms name the *store's* failures rather than the port's. Rather than widen every one of them,
 * the caller says which of its own failures a dead host reads as — and the sentence that comes
 * back says the tab closed, so nobody diagnoses a database from it.
 */
export const uncarry = <T, E extends AnyTaggedError>(
  answer: unknown,
  whenLost: (cause: unknown) => E,
): ResultType<T, E> => {
  const carried = answer as Carried;
  // SAFETY: the host answers each read with what that read's own method returned, revived below
  if (carried.ok) return Result.ok(revive(carried.value) as T);
  const revived = inspectFailures.revive(carried.error);
  // SAFETY: the host only serialises the failures its own reader declares, which is this catalog
  return Result.err(revived === undefined ? whenLost(carried.error) : (revived as E));
};

/** Which channels a refreshed reader speaks for, as a set a listener can be handed. */
export const channelsFor = (names: readonly SnapshotName[]): ReadonlySet<DevtoolsChannel> => {
  const moved = new Set<DevtoolsChannel>();
  for (const name of names) for (const channel of SNAPSHOT_CHANNELS[name]) moved.add(channel);
  return moved;
};
