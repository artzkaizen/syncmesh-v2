import type {
  CellValue,
  JsonValue,
  PartitionKey,
  Procedure,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { PeerId } from "@syncmesh/kernel";
import type { PolicyDoc } from "@syncmesh/policy";
import type { Result } from "@syncmesh/result";

import { RESERVED } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";

import type { Engine, MutateOptions } from "./engine.js";
import type { MutateError } from "./errors.js";
import type { Tx } from "./tx.js";

/**
 * The three things an authority can do that a device cannot (RFC-0014). It is not a different
 * animal — same engine, same events, same signatures — it simply always runs, holds the whole
 * log, and its grant carries authority. Everything here is an ordinary signed event that every
 * peer folds by the ordinary rules.
 */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved tables' own names and keys, fixed by this module */
const SET_POLICY = "_policy.set" as Procedure;
const CORRECT = "_corrections.write" as Procedure;
const REVOKE = "_revocations.write" as Procedure;
/** A reserved table's own column, whose kind the schema check proved when the row was written. */
export const column = (name: string) => name as never;
export const rowKey = (key: string) => key as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/**
 * Whose signature a reserved row carries: the authority's, or the row's own subject's (D21).
 *
 * A lookup and never a name check, so a fifth reserved table has to *choose* rather than inherit
 * whichever rule happened to be written at the dispatch. Exactly one table takes `subject`
 * today — `_links`, where the account signs the row's core and the device signs the event
 * carrying it, which is the only way one envelope can hold a mutual claim.
 */
/**
 * Reserved tables whose rows are about no instance, and so must be written with no partition.
 *
 * A reserved row's `partition` is set at fold from the event's, first-seen-wins, and is hashed
 * into its digest — so a row written under whichever instance an event happened to carry is a
 * row two peers can disagree about forever. A table here says the question does not apply, and
 * the rung refuses the write rather than letting the disagreement become possible.
 */
export const UNPINNED_RESERVED: ReadonlySet<string> = new Set([RESERVED.cdc]);

export const RESERVED_AUTHOR_CLASS: ReadonlyMap<string, ReservedAuthorClass> = new Map([
  [RESERVED.policy, "authority"],
  [RESERVED.corrections, "authority"],
  [RESERVED.revocations, "authority"],
  [RESERVED.links, "subject"],
  [RESERVED.cdc, "authority"],
] satisfies readonly (readonly [string, ReservedAuthorClass])[]);

export type ReservedAuthorClass = "authority" | "subject";

/** Names the reserved tables so a validator can hold each to the rule its author class names. */
export const RESERVED_TABLE_NAMES: ReadonlySet<string> = new Set(RESERVED_AUTHOR_CLASS.keys());

/**
 * Publishes the rules for one instance as data, so a permission change deploys by sync rather
 * than by app release. The row lives in the instance it governs, which is what makes it travel
 * to exactly the devices it binds, and every validator prefers it over the bundled manifest.
 *
 * `grace` narrows how long a cached grant is trusted **in this instance only**: a device must have
 * renewed within `expiresAt - grace` rather than merely hold an unexpired grant, which is the
 * containment for one that is offline with a long-lived grant. It only ever tightens, and absent
 * it nothing changes.
 *
 * ```ts
 * await setPolicy(engine, ACME, { jobs: { $default: deny, read: role("viewer") } })
 * await setPolicy(engine, ACME, doc, { grace: Temporal.Duration.from({ hours: 12 }) })
 * ```
 */
export function setPolicy(
  engine: Engine,
  partition: PartitionKey,
  doc: PolicyDoc,
  options: { readonly version?: number; readonly grace?: Temporal.Duration } = {},
): Promise<Result<SyncEvent, MutateError>> {
  const version = options.version ?? Date.now();
  const cells = new Map<never, CellValue>([
    [column("id"), partition],
    // SAFETY: a PolicyDoc is a plain-data AST — exactly what a json column holds
    [column("rules"), doc as JsonValue],
    [column("version"), version],
  ]);
  // the cell is written only when there is a grace to write. Not for an older build's sake — its
  // check drops a column it does not declare (D13's additive rule, `columns.ts`), so the cell
  // would cost it nothing — but because an omitted nullable column reads as absent, which is
  // exactly what "no grace" means
  if (options.grace !== undefined)
    cells.set(column("grace"), options.grace.total({ unit: "milliseconds" }));
  return engine.mutate(SET_POLICY, (tx) => tx.insert(RESERVED.policy, rowKey(partition), cells), {
    partition,
  } satisfies MutateOptions);
}

/** What one correction records: the event it overrules, the row it fixes, and why. */
export interface Correction {
  /** The event whose value is being overruled — what a device shows next to the change. */
  readonly event: string;
  readonly table: TableName;
  readonly key: RowKey;
  /** Why, in the authority's words. Shown to a person, so write it for one. */
  readonly reason: string;
  readonly detail?: JsonValue;
  readonly partition: PartitionKey;
}

/**
 * The authority's answer to a write it will not accept. It cannot *reject*: a device that was
 * offline when the verdict was made would keep its provisional value forever, with nothing ever
 * contradicting it. So rejection is an **overwrite with a reason** — the corrected value and the
 * `_corrections` row in one signed event, which every peer folds by the ordinary merge, and
 * which a UI can render as "changed by the office, because …" rather than a silent revert.
 *
 * ```ts
 * await correct(engine, { event, table: JOBS, key, reason: "over the day limit", partition },
 *   (tx) => tx.update(JOBS, key, new Map([[HOURS, 8]])))
 * ```
 */
export function correct(
  engine: Engine,
  correction: Correction,
  fix: (tx: Tx) => void,
): Promise<Result<SyncEvent, MutateError>> {
  const { event, table, key, reason, detail, partition } = correction;
  const cells = new Map([
    [column("id"), `${event}:${table}:${key}`],
    [column("eventId"), event],
    [column("table"), table],
    [column("key"), key],
    [column("reason"), reason],
    [column("detail"), detail ?? null],
  ]);
  return engine.mutate(
    CORRECT,
    (tx) => {
      fix(tx); // the overwrite and its reason are one event: a peer cannot fold one without the other
      tx.insert(RESERVED.corrections, rowKey(`${event}:${table}:${key}`), cells);
    },
    { partition } satisfies MutateOptions,
  );
}

/**
 * How a reserved table files a fact about one device: the instance it concerns, then the device
 * it names. `_revocations` and `_links` both key this way, and for the same reason — a device
 * removed from one org keeps whatever it holds in another.
 */
const deviceRowKey = (partition: PartitionKey, device: PeerId): RowKey =>
  rowKey(`${partition}:${device}`);

/** The inverse: which instance and which device a key filed by {@link deviceRowKey} names. */
function splitDeviceKey(filed: RowKey | string) {
  const split = filed.lastIndexOf(":");
  return { partition: filed.slice(0, split), device: filed.slice(split + 1) };
}

/** The key a revocation is filed under. */
export const revocationKey = deviceRowKey;

/** What one revocation records: whose powers were withdrawn, from where, when, and why. */
export interface Revocation {
  readonly device: PeerId;
  readonly partition: PartitionKey;
  /** Why, in the authority's words. Shown to a person, so write it for one. */
  readonly reason: string;
  /** From when; defaults to now. A grant issued after this instant is unaffected. */
  readonly at?: Temporal.Instant;
}

/**
 * Withdraws a device's powers in one instance, as a signed row every peer folds.
 *
 * The registry's local `revoke` cannot do this. A peer that was offline when a device was
 * removed would go on honouring the grant it holds, with nothing ever contradicting it — the
 * same defect a rejection has, and the same fix: say it in the log, in the instance it concerns,
 * so it travels by ordinary anti-entropy to exactly the devices that need to hear it.
 *
 * **A revocation is an instant, not a tombstone.** It withdraws the grants issued up to that
 * moment and says nothing about later ones, so re-issuing readmits a device with no second verb
 * to call and no state to unwind — the same newest-wins rule the registry already applies to
 * grants, expressed once more in the log.
 *
 * ```ts
 * await revokeDevice(engine, { device: lost, partition: ACME, reason: "reported stolen" })
 * ```
 */
export function revokeDevice(
  engine: Engine,
  revocation: Revocation,
): Promise<Result<SyncEvent, MutateError>> {
  const { device, partition, reason } = revocation;
  const at = revocation.at ?? Temporal.Now.instant();
  const key = revocationKey(partition, device);
  const cells = new Map<never, CellValue>([
    [column("id"), key],
    [column("at"), at.epochMilliseconds],
    [column("reason"), reason],
  ]);
  return engine.mutate(REVOKE, (tx: Tx) => tx.insert(RESERVED.revocations, key, cells), {
    partition,
  } satisfies MutateOptions);
}

/** A revocation as a reader sees it. */
export interface RevocationRow {
  readonly device: string;
  readonly partition: string;
  readonly at: Temporal.Instant;
  readonly reason: string;
}

/**
 * When this device's powers were withdrawn in one instance, if they were — the same row the
 * validator's rung reads, for a caller deciding *about* a device rather than about an event.
 */
export function revokedAt(
  engine: Engine,
  partition: PartitionKey,
  device: PeerId,
): Temporal.Instant | undefined {
  const record = engine.state().get(RESERVED.revocations)?.get(revocationKey(partition, device));
  if (record === undefined || record.deleteStamp !== undefined) return undefined;
  return Temporal.Instant.fromEpochMilliseconds(moment(record.cells.get(column("at"))?.value));
}

/** Every revocation this device holds for the instances it syncs, oldest first. */
export function revocations(engine: Engine): readonly RevocationRow[] {
  const rows = engine.state().get(RESERVED.revocations);
  if (rows === undefined) return [];
  return [...rows]
    .filter(([, record]) => record.deleteStamp === undefined)
    .map(([key, record]) => ({
      ...splitDeviceKey(key),
      at: Temporal.Instant.fromEpochMilliseconds(moment(record.cells.get(column("at"))?.value)),
      reason: text(record.cells.get(column("reason"))?.value),
    }))
    .sort((a, b) => Temporal.Instant.compare(a.at, b.at));
}

/** A correction as a reader sees it. */
export interface CorrectionRow {
  readonly event: string;
  readonly table: string;
  readonly key: string;
  readonly reason: string;
  readonly detail: JsonValue | null;
}

/**
 * A reserved text column's cell. The column check proved it a string when the row was written,
 * so anything else here is a record this device should not have folded — read as absent rather
 * than stringified into `[object Object]`.
 */
export const text = (value: CellValue | undefined): string => (isText(value) ? value : "");

/** A reserved integer column's cell, on the same terms; an absent instant reads as the epoch. */
export const moment = (value: CellValue | undefined): number => (isWhole(value) ? value : 0);

/* oxlint-disable anti-slop/no-runtime-typeof -- the one narrowing of a stored cell back to its column's kind */
const isText = (value: CellValue | undefined): value is string => typeof value === "string";
const isWhole = (value: CellValue | undefined): value is number => typeof value === "number";
/* oxlint-enable anti-slop/no-runtime-typeof */

/** Every correction this device holds, oldest key first; `forEvent` narrows to one overruled write. */
export function corrections(engine: Engine): readonly CorrectionRow[] {
  const rows = engine.state().get(RESERVED.corrections);
  if (rows === undefined) return [];
  return [...rows]
    .filter(([, record]) => record.deleteStamp === undefined)
    .map(([, record]) => {
      const cell = (name: string): CellValue | undefined => record.cells.get(column(name))?.value;
      return {
        event: text(cell("eventId")),
        table: text(cell("table")),
        key: text(cell("key")),
        reason: text(cell("reason")),
        // SAFETY: `detail` is a json column, so its cell is a JsonValue or null by the column check
        detail: (cell("detail") ?? null) as JsonValue | null,
      };
    })
    .sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}
