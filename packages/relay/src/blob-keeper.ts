import type { StoreFailure } from "@syncmesh/engine";
import type { PartitionKey, SyncEvent } from "@syncmesh/kernel";
import type { BlobError, BlobHash, BlobHomes, BlobStore } from "@syncmesh/storage";

import { Result } from "@syncmesh/result";
import { BlobQuotaExceeded, blobNamesIn } from "@syncmesh/storage";
import { Temporal, addToInstant } from "@syncmesh/temporal";

/** What a room lends the blobs it keeps: where they live, its budget and window, and its clock. */
export interface BlobKeeperOptions {
  /** The room's store, capped when it has a ceiling — a sweep's delete goes through the cap. */
  readonly store: BlobStore;
  /** Every partition a put billed each blob to (D44): what a grant-gated room serves a fetch by. */
  readonly homes: BlobHomes;
  /** Bytes one partition may hold here; absent, every partition may hold as much as it likes. */
  readonly quota: number | undefined;
  /** How long a blob nothing references is kept; absent, the sweep removes nothing. */
  readonly keepUnreferencedFor: Temporal.Duration | undefined;
  readonly now: () => Temporal.Instant;
}

/**
 * The relay's half of D18's obligations: it holds a blob while a row it can see references the
 * hash, sweeps one nothing has referenced for a window, and refuses a put that would carry a
 * partition past its byte budget — as a value the putter is told, before anything is stored.
 *
 * **What "references" means here, and why it is not "a visible row".** A relay does not fold, so
 * it cannot know whether the row that named a hash still exists. What it can see is every event
 * it ingests: a string cell, at any depth of a value, spelled like a blob name, is a reference.
 * **Once seen, a reference is kept for the life of this instance**, through any trim of the log:
 * a row inserted once and never written again still exists on every device after its event is
 * trimmed, and the relay is that blob's durable home (D18). So the sweep frees only blobs no
 * event has ever named — an upload whose row never arrived — and deleting a row frees nothing.
 * Telling a deleted row from a live one would take a fold the relay does not run.
 *
 * Four more limits, each in the keeping direction or recoverable:
 * - **A sealed event names nothing the relay can read.** The first one this room sees makes the
 *   sweep stand down for good, because "no reference I can see" is no longer "no reference".
 * - **Only bytes put since the room opened are swept or billed.** The `BlobStore` port cannot
 *   enumerate what an earlier run left on disk, so those blobs are kept and cost no budget — and
 *   so are bytes put again that were already on disk, whose referencing event may have been
 *   trimmed before this instance booted.
 * - **References are the ones this instance ingested or booted with.** Another instance's event
 *   that never fanned in here is invisible — a blob swept under it answers `blob-missing`, which
 *   is recoverable by anyone still holding the bytes, because the name is the content.
 * - **The set of names seen only grows.** One entry per distinct hash ever referenced, held or
 *   not, for as long as the instance runs.
 *
 * The partition a put is billed to is the putter's claim (a `blob-put` carries it). An open room
 * takes it as a budget; a grant-gated room checks it against the putter's grant before the put
 * reaches here (D44), and every put that lands records the partition as one of the blob's
 * {@link BlobHomes} — where a fetch may be served from. A home comes only from a verified put, so
 * it is a claim made by someone who held the bytes, never by someone who only knew the hash.
 */
export interface BlobKeeper {
  /**
   * Stores the bytes under their name, verified, unless their partition's budget would pass its
   * quota — then nothing is stored and the putter learns the budget and the spend. Bytes already
   * held are stored once and billed once, whoever puts them again.
   */
  readonly put: (
    hash: BlobHash,
    bytes: Uint8Array,
    partition: PartitionKey | undefined,
  ) => Promise<Result<void, BlobError | BlobQuotaExceeded | StoreFailure>>;
  /**
   * Whether a socket entitled to `partitions` may be served these bytes (D44): a put billed them
   * to one of those partitions, or to none. Bytes no put of this room recorded are nobody's.
   */
  readonly readable: (
    hash: BlobHash,
    partitions: readonly PartitionKey[],
  ) => Promise<Result<boolean, StoreFailure>>;
  /** Every blob name an event this room now holds references. */
  readonly note: (event: SyncEvent) => void;
  /** These bytes left the store some other way — the cap evicted them — so stop billing them. */
  readonly forget: (hash: BlobHash) => void;
  /** Removes every blob unreferenced for the window, and answers how many went. */
  readonly sweep: () => Promise<number>;
}

/** One blob this room admitted: its size, whose budget it is on, and when it was last put. */
interface Held {
  readonly bytes: number;
  readonly partition: PartitionKey | undefined;
  since: Temporal.Instant;
}

/** What one change could reference: the cells it writes, or the payload a newer build wrote. */
const written = (event: SyncEvent): unknown[] =>
  event.changes.map((change) => {
    if (change.kind === "insert") return [...change.row.values()];
    if (change.kind === "update") return [...change.patch.values()];
    if (change.kind === "unknown") return change.data;
    return [];
  });

export function createBlobKeeper(options: BlobKeeperOptions): BlobKeeper {
  const { store, homes, quota, keepUnreferencedFor, now } = options;
  const held = new Map<BlobHash, Held>();
  /** Per partition (absent is its own budget), the bytes billed to it. */
  const used = new Map<PartitionKey | undefined, number>();
  /** Every blob name an event this instance ingested or booted with has referenced. */
  const references = new Set<BlobHash>();
  /** A sealed event arrived: some references are unreadable here, so nothing is provably free. */
  let blind = false;

  const unbill = (hash: BlobHash): void => {
    const entry = held.get(hash);
    if (entry === undefined) return;
    held.delete(hash);
    used.set(entry.partition, (used.get(entry.partition) ?? 0) - entry.bytes);
  };

  return {
    put: async (hash, bytes, partition) => {
      const at = now();
      const known = held.get(hash);
      // bytes already on disk that this instance never admitted are an earlier run's: kept, and
      // costing no budget, since the event that named them may have been trimmed before this boot
      const fresh = known === undefined && !(await store.has(hash));
      const spent = used.get(partition) ?? 0;
      if (fresh && quota !== undefined && spent + bytes.byteLength > quota)
        return Result.err(
          new BlobQuotaExceeded({
            hash,
            partition,
            limit: quota,
            used: spent,
            message: `${partition ?? "the unnamed budget"} holds ${spent} of ${quota} bytes; ${bytes.byteLength} more would pass it`,
          }),
        );
      const stored = await store.putAt(hash, bytes);
      if (stored.isErr()) return stored;
      // after the store verified the bytes: a home is recorded only for someone who held them
      const homed = await homes.add(hash, partition);
      if (homed.isErr()) return homed;
      if (known !== undefined) known.since = at;
      else if (fresh) {
        held.set(hash, { bytes: bytes.byteLength, partition, since: at });
        // read again, not `spent`: the ceiling may have evicted, and unbilled, during the put
        used.set(partition, (used.get(partition) ?? 0) + bytes.byteLength);
      }
      return stored;
    },
    readable: async (hash, partitions) =>
      (await homes.of(hash)).map((found) =>
        found.some((home) => home === undefined || partitions.includes(home)),
      ),
    note: (event) => {
      if (event.sealed === true) blind = true;
      for (const hash of blobNamesIn(written(event))) references.add(hash);
    },
    forget: unbill,
    sweep: async () => {
      if (keepUnreferencedFor === undefined || blind) return 0;
      const cut = addToInstant(now(), keepUnreferencedFor.negated());
      // chosen in one synchronous pass, then deleted: the room's queue runs this, but a delete
      // that yields must not find the set it is walking changed under it
      const due = [...held]
        .filter(
          ([hash, entry]) =>
            !references.has(hash) && Temporal.Instant.compare(entry.since, cut) <= 0,
        )
        .map(([hash]) => hash);
      for (const hash of due) unbill(hash);
      for (const hash of due) {
        await store.delete(hash);
        // a home outliving its bytes would be harmless — a fetch finds nothing — but it is a row
        // per blob ever swept; a failed forget is the same harmless leftover, so it is not fatal
        await homes.forget(hash);
      }
      return due.length;
    },
  };
}
