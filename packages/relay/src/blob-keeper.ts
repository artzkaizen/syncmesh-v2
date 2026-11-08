import type { StoreFailure, StoredEvent } from "@syncmesh/engine";
import type { PartitionKey, SyncEvent } from "@syncmesh/kernel";
import type {
  BlobError,
  BlobHash,
  BlobHome,
  BlobHomes,
  BlobLedger,
  BlobStore,
  BlobWindow,
} from "@syncmesh/storage";

import { Result } from "@syncmesh/result";
import { BlobQuotaExceeded, memoryBlobLedger } from "@syncmesh/storage";
import { Temporal, addToInstant } from "@syncmesh/temporal";

import { createBlobReferences } from "./blob-references.js";

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
  /**
   * Where the references are kept across a trim of the log and a restart (gaps U18); absent, for
   * this process only — which is enough for a room whose log has never been trimmed.
   */
  readonly ledger?: BlobLedger;
  /**
   * The log had already been trimmed when this room opened. A ledger that did not see those
   * events cannot vouch for what they named, so an earlier run's blobs stay unswept and unbilled.
   */
  readonly trimmedBefore?: boolean;
}

/**
 * The relay's half of D18's obligations: it holds a blob while a row it can see references the
 * hash, sweeps one nothing has referenced for a window, and refuses a put that would carry a
 * partition past its byte budget — as a value the putter is told, before anything is stored.
 *
 * **What "references" means here.** A relay does not fold cells, so it follows the one part of a
 * row it can without a schema: whether the row exists. A string cell, at any depth of a value,
 * spelled like a blob name is a reference, held by the row that carried it until that row is
 * deleted — by the kernel's own rule, a delete stamped after the row's latest write — and from the
 * delete the blob is kept for the window before it is swept, as D18 has it, because an offline
 * device's write can still bring the row back. See `createBlobReferences` for what it does not
 * follow, all in the keeping direction.
 *
 * **References outlive the log.** A row inserted once and never written again still exists on
 * every device after its insert is trimmed, and the relay is that blob's durable home. So what the
 * rows named is kept in a {@link BlobLedger} beside the blobs, saved before every trim
 * ({@link BlobKeeper.save}); a room reopened over a trimmed log reads it back. With a ledger that
 * has seen the whole log, the blobs an earlier run left on disk are read from the store's
 * inventory at open and billed and swept like any other. Each blob's window — when its put, or
 * the delete that released it, started it — is saved with the rows, so a room that reopens more
 * often than the window still sweeps; a blob the ledger never saw put is given one from the open
 * that first found it, and a window moved after the last save starts over from the next open.
 *
 * **Sealed events.** One names nothing the relay can read, so a reference it cannot see may be in
 * any blob put into that event's partition: those blobs, and those put into no partition, which
 * any row may name, are kept for good. A sealed event in no partition keeps every blob.
 *
 * What is left, each in the keeping direction or recoverable:
 * - **References are the ones this instance ingested, booted with or read from its ledger.**
 *   Another instance's event that never fanned in here is invisible — a blob swept under it
 *   answers `blob-missing`, recoverable by anyone still holding the bytes, because the name is the
 *   content.
 * - **A room whose log was trimmed before it had a ledger** keeps an earlier run's blobs unswept
 *   and unbilled, as every room did before the ledger, and bytes put again that were already on
 *   disk are kept and unbilled too.
 * - **The rows held only grow**: one entry per row that ever named a blob, live or deleted.
 *
 * The partition a put is billed to is the putter's claim (a `blob-put` carries it). An open room
 * takes it as a budget; a grant-gated room checks it against the putter's grant before the put
 * reaches here (D44), and every put that lands records the partition as one of the blob's
 * {@link BlobHomes} — where a fetch may be served from. A home comes only from a verified put, so
 * it is a claim made by someone who held the bytes, never by someone who only knew the hash.
 */
export interface BlobKeeper {
  /**
   * Reads back what the ledger kept, the store's inventory where the ledger has seen the whole log,
   * and every reference the log already holds. Once, before the room serves anything.
   */
  readonly open: (held: readonly StoredEvent[]) => Promise<Result<void, StoreFailure>>;
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
  /** Every blob reference, and every release, an event this room now holds makes. */
  readonly note: (event: SyncEvent) => void;
  /** These bytes left the store some other way — the cap evicted them — so stop billing them. */
  readonly forget: (hash: BlobHash) => void;
  /**
   * Writes what was noted since the last save to the ledger. A trim of the log waits for it: an
   * event trimmed before its references were saved would take them with it on the next restart.
   */
  readonly save: () => Promise<Result<void, StoreFailure>>;
  /** Removes every blob unreferenced for the window, and answers what it did. */
  readonly sweep: () => Promise<BlobSweep>;
}

/** What one sweep did and what it left, in counts and bytes — never a hash (D48). */
export interface BlobSweep {
  readonly swept: number;
  readonly sweptBytes: number;
  /** Blobs, and their bytes, still held after the sweep. */
  readonly held: number;
  readonly heldBytes: number;
  /** Held blobs a live row names. */
  readonly referenced: number;
  /** Unreferenced blobs kept because a sealed event's partition may name them. */
  readonly sealed: number;
}

/** One blob this room admitted: its size, whose budget it is on, and when its window started. */
interface Held {
  readonly bytes: number;
  readonly partition: PartitionKey | undefined;
  since: Temporal.Instant;
}

/** The partition an earlier run's blob is billed to: one of its homes, the same one every open. */
const billedHome = (homes: readonly BlobHome[]): PartitionKey | undefined =>
  homes.filter((home) => home !== undefined).sort()[0];

const later = (a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant =>
  Temporal.Instant.compare(a, b) >= 0 ? a : b;

/** Whether a sealed event's partition may name this blob, so no reference to it is provable. */
async function blinded(
  hash: BlobHash,
  sealed: ReadonlySet<BlobHome>,
  homes: BlobHomes,
): Promise<boolean> {
  if (sealed.size === 0) return false;
  if (sealed.has(undefined)) return true;
  const found = await homes.of(hash);
  // a home that cannot be read is no proof of anything: keep it
  if (found.isErr()) return true;
  const where = found.value;
  return where.length === 0 || where.some((home) => home === undefined || sealed.has(home));
}

/** Window starts not yet saved to the ledger; `undefined` for a blob that left. */
function createUnsavedWindows() {
  const fresh = new Map<BlobHash, Temporal.Instant | undefined>();
  return {
    mark: (hash: BlobHash, since: Temporal.Instant | undefined): void =>
      void fresh.set(hash, since),
    take: (): readonly BlobWindow[] => {
      const out = [...fresh].map(([hash, since]) => ({ hash, since }));
      fresh.clear();
      return out;
    },
    /** A save failed: these go again, unless a newer start was marked while it was out. */
    retake: (windows: readonly BlobWindow[]): void => {
      for (const { hash, since } of windows) if (!fresh.has(hash)) fresh.set(hash, since);
    },
  };
}

export function createBlobKeeper(options: BlobKeeperOptions): BlobKeeper {
  const { store, homes, quota, keepUnreferencedFor, now } = options;
  const ledger = options.ledger ?? memoryBlobLedger();
  const held = new Map<BlobHash, Held>();
  /** Per partition (absent is its own budget), the bytes billed to it. */
  const used = new Map<PartitionKey | undefined, number>();
  const references = createBlobReferences();
  /** The partitions a sealed event arrived in; `undefined` for one with none, which blinds all. */
  const sealed = new Set<BlobHome>();
  /** Sealed partitions not yet saved. */
  const sealedFresh = new Set<BlobHome>();
  /** Whether the references held have seen the whole log; settled at `open`. */
  let complete: boolean | undefined;
  const unsaved = createUnsavedWindows();

  /** Starts this blob's window at `at`, unless it already started later. */
  const restart = (hash: BlobHash, entry: Held, at: Temporal.Instant): void => {
    entry.since = later(entry.since, at);
    unsaved.mark(hash, entry.since);
  };

  const unbill = (hash: BlobHash): void => {
    const entry = held.get(hash);
    if (entry === undefined) return;
    held.delete(hash);
    used.set(entry.partition, (used.get(entry.partition) ?? 0) - entry.bytes);
    unsaved.mark(hash, undefined);
  };

  const bill = (
    hash: BlobHash,
    bytes: number,
    partition: PartitionKey | undefined,
    since: Temporal.Instant,
  ): void => {
    held.set(hash, { bytes, partition, since });
    used.set(partition, (used.get(partition) ?? 0) + bytes);
    unsaved.mark(hash, since);
  };

  const note = (event: SyncEvent): void => {
    if (event.sealed === true) {
      if (!sealed.has(event.partition)) sealedFresh.add(event.partition);
      sealed.add(event.partition);
      return;
    }
    const at = now();
    // the window of a blob a delete just released starts now, not at its put (D18)
    for (const hash of references.note(event)) {
      const entry = held.get(hash);
      if (entry !== undefined) restart(hash, entry, at);
    }
  };

  /**
   * An earlier run's blobs, billed — only with a ledger that saw them — each with the window the
   * ledger kept for it, or one from now for a blob it never saw put.
   */
  const seed = async (
    windows: ReadonlyMap<BlobHash, Temporal.Instant>,
  ): Promise<Result<void, StoreFailure>> => {
    if (complete !== true || ledger.stored === undefined) return Result.ok(undefined);
    const inventory = await ledger.stored();
    if (inventory.isErr()) return Result.err(inventory.error);
    const at = now();
    for (const [hash, bytes] of inventory.value) {
      const where = await homes.of(hash);
      if (where.isErr()) return Result.err(where.error);
      bill(hash, bytes, billedHome(where.value), windows.get(hash) ?? at);
    }
    return Result.ok(undefined);
  };

  return {
    open: async (log) => {
      const loaded = await ledger.load();
      if (loaded.isErr()) return Result.err(loaded.error);
      references.restore(loaded.value.rows);
      for (const home of loaded.value.sealed) sealed.add(home);
      // a ledger starting now has seen everything only if nothing was trimmed before it
      complete = loaded.value.complete ?? options.trimmedBefore !== true;
      const windows = new Map<BlobHash, Temporal.Instant>();
      for (const { hash, since } of loaded.value.windows)
        if (since !== undefined) windows.set(hash, since);
      const seeded = await seed(windows);
      if (seeded.isErr()) return seeded;
      // a release the ledger saved is no release here — the restored row is already deleted — so
      // only one made after the last save starts its blob's window over, from now
      for (const entry of log) note(entry.event);
      return Result.ok(undefined);
    },
    put: async (hash, bytes, partition) => {
      const at = now();
      const known = held.get(hash);
      // bytes already on disk that this instance never admitted are an earlier run's that no
      // complete ledger vouched for: kept, and costing no budget
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
      // read again, not `spent`: the ceiling may have evicted, and unbilled, during the put
      if (known !== undefined) restart(hash, known, at);
      else if (fresh) bill(hash, bytes.byteLength, partition, at);
      return stored;
    },
    readable: async (hash, partitions) =>
      (await homes.of(hash)).map((found) =>
        found.some((home) => home === undefined || partitions.includes(home)),
      ),
    note,
    forget: unbill,
    save: async () => {
      const rows = references.taken();
      const fresh = [...sealedFresh];
      sealedFresh.clear();
      const windows = unsaved.take();
      const saved = await ledger.save({ rows, windows, sealed: fresh, complete });
      if (saved.isErr()) {
        references.retake(rows);
        for (const home of fresh) sealedFresh.add(home);
        unsaved.retake(windows);
      }
      return saved;
    },
    sweep: async () => {
      const referenced = references.referenced();
      const report = { swept: 0, sweptBytes: 0, sealed: 0 };
      if (keepUnreferencedFor !== undefined) {
        const cut = addToInstant(now(), keepUnreferencedFor.negated());
        // chosen in one synchronous pass, then checked and deleted: the room's queue runs this, but
        // a delete that yields must not find the set it is walking changed under it
        const candidates = [...held]
          .filter(
            ([hash, entry]) =>
              !referenced.has(hash) && Temporal.Instant.compare(entry.since, cut) <= 0,
          )
          .map(([hash, entry]) => [hash, entry.bytes] as const);
        const due: (readonly [BlobHash, number])[] = [];
        for (const candidate of candidates) {
          if (await blinded(candidate[0], sealed, homes)) report.sealed += 1;
          else due.push(candidate);
        }
        for (const [hash] of due) unbill(hash);
        for (const [hash, bytes] of due) {
          await store.delete(hash);
          // a home outliving its bytes would be harmless — a fetch finds nothing — but it is a row
          // per blob ever swept; a failed forget is the same harmless leftover, so it is not fatal
          await homes.forget(hash);
          report.swept += 1;
          report.sweptBytes += bytes;
        }
      }
      let heldBytes = 0;
      let named = 0;
      for (const [hash, entry] of held) {
        heldBytes += entry.bytes;
        if (referenced.has(hash)) named += 1;
      }
      return { ...report, held: held.size, heldBytes, referenced: named };
    },
  };
}
