import type { BlobHomes, BlobLedger, BlobStore, SqlDriver } from "@syncmesh/storage";

import { panic } from "@syncmesh/result";
import { sqlBlobHomes, sqlBlobLedger, sqlBlobStore } from "@syncmesh/storage";

/**
 * A durable room's blob homes on its own database, or a stop: a gated room that fell back to
 * homes in memory would answer every fetch `blob-missing` after its next restart, unsaid (D44).
 */
export const openBlobHomes = async (driver: SqlDriver): Promise<BlobHomes> =>
  (await sqlBlobHomes(driver)).match({
    ok: (homes) => homes,
    err: (failure) => panic(`the room's blob homes failed to open: ${failure.message}`),
  });

/**
 * A durable room's blob ledger on its own database (gaps U18), or a stop: a room that fell back to
 * one in memory would forget, at its next restart, what the events it had trimmed referenced.
 */
export const openBlobLedger = async (driver: SqlDriver): Promise<BlobLedger> =>
  (await sqlBlobLedger(driver)).match({
    ok: (ledger) => ledger,
    err: (failure) => panic(`the room's blob ledger failed to open: ${failure.message}`),
  });

/** A durable room's blob half on its own database: the bytes, where each may be read, and what the rows named. */
export interface DurableBlobs {
  readonly blobs?: BlobStore;
  readonly blobHomes: BlobHomes;
  readonly blobLedger: BlobLedger;
}

/**
 * The bytes, their homes (D44) and their ledger (gaps U18), all on the room's own connection —
 * never shared across rooms, because a room that inherited another room's store would serve and
 * keep another room's bytes under D18. What every durable host opens beside a room's log.
 */
export async function openDurableBlobs(driver: SqlDriver): Promise<DurableBlobs> {
  const opened = await sqlBlobStore(driver);
  const blobHomes = await openBlobHomes(driver);
  const blobLedger = await openBlobLedger(driver);
  return opened.isOk() ? { blobs: opened.value, blobHomes, blobLedger } : { blobHomes, blobLedger };
}
