import type { PartitionKey, PeerId, Row, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { Quarantined } from "./engine.js";
import type { EngineError, ValidationError } from "./errors.js";
import type { QuarantineStore, UnknownHandling } from "./quarantine.js";
import type { EventStore, StoredEvent } from "./store.js";
import type { StateLookup, Validator } from "./validate.js";

import { unfoldableKind } from "./columns.js";
import { UnknownChangeKind } from "./errors.js";
import { UnreadableEvent, isUnknown, quarantineReason } from "./quarantine.js";

interface Hubs {
  readonly quarantine: { readonly emit: (q: Quarantined) => void };
  readonly errors: { readonly emit: (e: EngineError) => void };
}

export interface AdmitDeps extends Hubs {
  readonly peerId: PeerId;
  readonly store: EventStore;
  readonly validate: Validator | undefined;
  readonly before: StateLookup;
  readonly parked: QuarantineStore;
  readonly unknownHandling: UnknownHandling;
}

/**
 * A change kind no fold here understands, before anything reads its cells. Checked even with no
 * validator configured, because the crash it prevents is in the kernel and not in the ladder: a
 * fold reaches for `patch` on a change that has none and takes the whole batch down with it.
 */
const unfoldable = (event: SyncEvent): ValidationError | undefined => {
  for (const change of event.changes) {
    const kind = unfoldableKind(change);
    if (kind !== undefined) {
      return new UnknownChangeKind({
        table: String(change.table),
        kind,
        message: `this build has no fold for a ${kind} change`,
      });
    }
  }
  return undefined;
};

/**
 * What the batch itself has already written, layered over what the device held before it.
 *
 * A patch carries what changed, and what owns a row is exactly what does not — so `owner()` on an
 * update reads the row the insert made. Validating every event of a batch against the state as it
 * was *before* the batch makes that row invisible whenever both arrive together, and the verdict
 * then depends on how the far side happened to page its history rather than on what was written.
 * A peer catching up sees every write of its absence at once, so that is the common case, not the
 * corner: one page instead of two would refuse a write the same events delivered singly allow.
 *
 * Only admitted events are layered. A parked event has been judged unwritable, and letting it
 * furnish the row that clears the next one would let a refusal launder itself.
 *
 * Approximate on purpose: this is existence and cell values, not the HLC merge `apply` performs.
 * A rule asks what a row says, and for that the last write in event order is the honest answer —
 * where a concurrent write elsewhere wins the merge, the fold settles it, and the fold runs after.
 */
const createOverlay = (
  before: StateLookup,
): StateLookup & { readonly took: (event: SyncEvent) => void } => {
  const rows = new Map<string, Map<string, Row | undefined>>();
  const partitions = new Map<string, PartitionKey>();
  const at = (table: TableName) => {
    const held = rows.get(String(table));
    if (held !== undefined) return held;
    const made = new Map<string, Row | undefined>();
    rows.set(String(table), made);
    return made;
  };

  const layered = {
    row: (table: TableName, key: RowKey) => {
      const held = rows.get(String(table));
      if (held?.has(String(key)) === true) return held.get(String(key));
      return before.row(table, key);
    },
    partition: (table: TableName, key: RowKey) =>
      partitions.get(`${String(table)}\u0000${String(key)}`) ?? before.partition(table, key),
    took: (event: SyncEvent) => {
      for (const change of event.changes) {
        // a doc change moves no cell a rule reads: its update is the log's, and a genesis sets
        // only the lineage cell, which is not a value any rule is written against
        if (change.kind === "unknown" || change.kind === "doc") continue;
        const held = at(change.table);
        const id = String(change.key);
        if (change.kind === "delete") held.set(id, undefined);
        else if (change.kind === "insert") {
          held.set(id, change.row);
          if (event.partition !== undefined)
            partitions.set(`${String(change.table)}\u0000${id}`, event.partition);
        } else {
          const current = held.get(id) ?? before.row(change.table, change.key);
          // an update to a row nothing has written stays absent: a patch is not an insert, and
          // inventing the row here would let a rule read cells no event ever authored
          if (current === undefined) continue;
          held.set(id, new Map([...current, ...change.patch]));
        }
      }
    },
  };

  // `records` enumerates a table, which the overlay cannot do faithfully: it holds only the rows
  // this batch touched. The device's own view is the honest answer, and a link this batch
  // introduces resolves on the next pass rather than being invented here.
  if (before.records === undefined) return layered;
  return { ...layered, records: before.records };
};

/**
 * Drops own, duplicate and already-stored entries; parks what fails, and returns the rest in
 * order.
 *
 * Parking is not folding and not storing: the event goes to the quarantine with the verdict this
 * build reached, and the author's cursor stops **below** it (D13). Advancing past a parked event
 * would be this device telling every peer it holds something it is still waiting to understand,
 * and no later exchange would ever offer it again.
 *
 * The cursor is what travels, not what gates delivery: a receiver walks the run using the cursor
 * *and* what `ahead` says is held, or one refusal no upgrade reverses would stop that author's
 * stream for the life of the device (`createHoldback`).
 */
export const admit = (entries: readonly StoredEvent[], deps: AdmitDeps) =>
  Result.gen(async function* () {
    const fresh: StoredEvent[] = [];
    const seen = new Set<string>();
    const overlay = createOverlay(deps.before);
    let quarantined = 0;
    for (const entry of entries) {
      const { event } = entry;
      if (event.peerId === deps.peerId || seen.has(event.id)) continue;
      seen.add(event.id);
      if (yield* Result.await(deps.store.has(event.id))) continue;
      const verdict = unfoldable(event) ?? refusal(deps, event, overlay);
      if (verdict !== undefined) {
        quarantined++;
        park(deps, entry, verdict);
        continue;
      }
      overlay.took(event);
      fresh.push(entry);
    }
    return Result.ok({ fresh, quarantined });
  });

const refusal = (
  deps: AdmitDeps,
  event: SyncEvent,
  before: StateLookup,
): ValidationError | undefined => {
  const verdict = deps.validate?.validate(event, before);
  return verdict !== undefined && verdict.isErr() ? verdict.error : undefined;
};

/**
 * Keeps the event and says so as loudly as the mesh asked to be told. `unknownHandling` moves
 * only the telling: every setting parks, and none of them folds, so two peers configured
 * differently still hold the same rows.
 */
const park = (deps: AdmitDeps, entry: StoredEvent, verdict: ValidationError): void => {
  const reason = quarantineReason(verdict);
  // said once, not once per retry: a refusal new state cannot clear is re-offered after every
  // batch that folds anything, and repeating an unchanged verdict buries the ones that did change
  const known = deps.parked
    .list()
    .some((held) => held.entry.event.id === entry.event.id && held.verdict._tag === verdict._tag);
  deps.parked.park({ entry, reason, verdict });
  const handling = isUnknown(reason) ? deps.unknownHandling : "warn";
  if (handling !== "ignore" && !known)
    deps.quarantine.emit({ event: entry.event, reason: verdict });
  if (handling === "fail") {
    deps.errors.emit(
      new UnreadableEvent({
        peer: entry.event.peerId,
        seqNum: entry.event.seqNum,
        reason,
        message: `parked (${reason}): ${verdict.message}`,
      }),
    );
  }
};
