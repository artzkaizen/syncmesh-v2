import type { Engine, FoldBatch, Narrowed, PurgeScope, Purged } from "@syncmesh/engine";
import type { PartitionKey, PeerId } from "@syncmesh/kernel";
import type { BlobHash, BlobStore } from "@syncmesh/storage";
import type { GrantRegistry } from "@syncmesh/wire";

import { entitledInterest, scopeFrom, scopeText } from "@syncmesh/engine";
import { getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { blobNamesIn, memoryBlobStore } from "@syncmesh/storage";

export interface NarrowingDeps {
  readonly engine: Engine;
  readonly self: PeerId;
  readonly grants: GrantRegistry;
  /** This device's blob cache; what a purged row named is dropped from it unless this device made it. */
  readonly blobs: BlobStore;
  /** The app's hook, run before anything is removed (D45). */
  readonly onNarrowed?: (narrowed: Narrowed) => Promise<void> | void;
}

/** Every blob a set of rows names, before or after a purge. */
const named = (rows: Purged["before"]): ReadonlySet<BlobHash> => {
  const names = new Set<BlobHash>();
  for (const { record } of rows)
    for (const hash of blobNamesIn([...record.cells.values()].map((cell) => cell.value)))
      names.add(hash);
  return names;
};

/**
 * The bytes a purge left nothing to name: cached copies of blobs the dropped rows referenced, and
 * that the rows rebuilt in their place no longer do. A blob this device made is kept — it may be
 * the only copy anywhere, and its author may always read what it wrote.
 */
async function dropBlobs(deps: NarrowingDeps, purged: Purged): Promise<void> {
  const state = deps.engine.state();
  const after = purged.before.flatMap(({ table, key }) => {
    const record = getRecord(state, table, key);
    return record === undefined ? [] : [{ table, key, record }];
  });
  const kept = named(after);
  for (const hash of named(purged.before)) {
    if (kept.has(hash)) continue;
    if ((await deps.blobs.origin(hash)) === "cached") await deps.blobs.delete(hash);
  }
}

/**
 * The scope a purge leaves this device's cursors claiming: the interest they were true for, cut to
 * the partitions it may still read. Recorded so a later widening re-pages what the purge took —
 * on a relay and on a peer link alike (D23) — instead of standing on cursors that say it is held.
 */
function rescope(engine: Engine, partitions: readonly PartitionKey[]): void {
  const coverage = engine.coverage();
  const { interest, entitlement } = scopeFrom(coverage.scope);
  const scope = scopeText(entitledInterest(interest, partitions), entitlement);
  engine.adoptCoverage({ synced: coverage.synced, local: coverage.local, scope });
}

/**
 * What a narrowed entitlement does on this device (D45): the app hears it first, then the device
 * purges what it may no longer read and the cached blobs only those rows named.
 *
 * Two things find a narrowing. This device's own grant naming fewer partitions than the one it
 * held is the first, found here. A relay re-paging this device under a narrower entitlement from
 * the authority is the second, found by that transport and handed to {@link purge}. Both run in
 * one queue, so two narrowings in quick succession purge in the order they were found.
 *
 * A device learns of a narrowing only when the grant reaches it; one that narrows while offline
 * purges on the next session that carries the grant. A failure is a warning, not a stop: the
 * device keeps working, and the next narrowing it learns of tries again.
 */
/** A purge of every held row and event of these partitions. */
const partitionsOut = (lost: ReadonlySet<PartitionKey>): PurgeScope => {
  const out = (partition: PartitionKey | undefined): boolean =>
    partition !== undefined && lost.has(partition);
  return { events: (event) => out(event.partition), rows: (record) => out(record.partition) };
};

/** Whether a fold wrote any row of these partitions. */
const wroteInto = (engine: Engine, batch: FoldBatch, lost: ReadonlySet<PartitionKey>): boolean => {
  const state = engine.state();
  for (const [table, keys] of batch.writeKeys)
    for (const key of keys) {
      const partition = getRecord(state, table, key)?.partition;
      if (partition !== undefined && lost.has(partition)) return true;
    }
  return false;
};

export function watchNarrowing(deps: NarrowingDeps) {
  const { engine, self, grants } = deps;
  let held = grants.all().find((grant) => grant.device === self)?.partitions;
  let queue: Promise<void> = Promise.resolve();
  /**
   * Partitions purged and not granted since. An event of one can still arrive after the purge — it
   * was in flight when the grant narrowed, before the far side heard of it — and is purged on
   * arrival, without telling the app again. Held for the process: a session opened after a restart
   * is already served under the narrower grant.
   */
  const lost = new Set<PartitionKey>();

  const purgeQuietly = async (scope: PurgeScope): Promise<void> => {
    const purged = await engine.purge(scope);
    if (purged.isErr()) {
      console.warn("a narrowed entitlement could not be purged:", purged.error);
      return;
    }
    await dropBlobs(deps, purged.value);
  };

  const run = async (narrowed: Narrowed, scope: PurgeScope): Promise<void> => {
    const told = await Result.tryPromise({
      try: async () => deps.onNarrowed?.(narrowed),
      catch: (cause) => cause,
    });
    // the hook is the app's; one that throws has still been told, and the purge goes ahead
    if (told.isErr()) console.warn("onNarrowed threw; purging anyway:", told.error);
    await purgeQuietly(scope);
  };

  const purge = (narrowed: Narrowed, scope: PurgeScope): Promise<void> => {
    queue = queue.then(() => run(narrowed, scope));
    return queue;
  };

  const offGrants = grants.onRegistered((grant) => {
    if (grant.device !== self) return;
    const before = held;
    held = grant.partitions;
    for (const partition of grant.partitions) lost.delete(partition);
    // the first grant this device holds narrows nothing: before it, this device read nothing
    if (before === undefined) return;
    const dropped = new Set<PartitionKey>(before.filter((p) => !grant.partitions.includes(p)));
    if (dropped.size === 0) return;
    for (const partition of dropped) lost.add(partition);
    const kept = grant.partitions;
    queue = queue.then(async () => {
      await run({ partitions: [...dropped], tables: [] }, partitionsOut(dropped));
      rescope(engine, kept);
    });
  });

  const offFolds = engine.onFoldBatch((batch) => {
    if (batch.source !== "remote" || lost.size === 0 || !wroteInto(engine, batch, lost)) return;
    const late = new Set(lost);
    queue = queue.then(() => purgeQuietly(partitionsOut(late)));
  });

  return {
    purge,
    /** Settles once every narrowing found so far has been purged — what persisting a grant waits on. */
    idle: (): Promise<void> => queue,
    stop: (): void => {
      offGrants();
      offFolds();
    },
  };
}

/**
 * The blob cache a mesh runs on — the one it was given, or memory — and the watch over it: one
 * store, because a purge drops from the cache the blob surface reads (D45).
 */
export function narrowingFor(
  engine: Engine,
  grants: GrantRegistry,
  options: {
    readonly identity: { readonly peerId: PeerId };
    readonly blobStore?: BlobStore;
    readonly onNarrowed?: NarrowingDeps["onNarrowed"];
  },
) {
  const blobStore = options.blobStore ?? memoryBlobStore();
  const deps = { engine, self: options.identity.peerId, grants, blobs: blobStore };
  if (options.onNarrowed !== undefined) Object.assign(deps, { onNarrowed: options.onNarrowed });
  return { blobStore, narrowing: watchNarrowing(deps) };
}
