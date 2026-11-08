import type { DocAddress } from "@syncmesh/engine";
import type { LineageId, PartitionKey } from "@syncmesh/kernel";
import type { KeyRing } from "@syncmesh/wire";

import { Result } from "@syncmesh/result";
import { encodeCbor, epochOf, openPayload, sealPayload } from "@syncmesh/wire";

import { CheckpointRefused, SnapshotUnsealable } from "./errors.js";

/**
 * The content keys a device holds for sealed partitions (D40): the newest epoch to seal under, any
 * epoch a payload names to open it. A mesh's key ring is one.
 */
export type SealingKeys = Pick<KeyRing, "keyFor" | "keyAt" | "epochFor">;

/**
 * The four bytes a sealed snapshot starts with, ahead of the sealed payload (`sm` `S` `1`): what
 * lets a host that holds no key refuse a sealed partition's checkpoint whose snapshot is not
 * sealed — an old build's, or one put together by hand — rather than store plaintext.
 */
const SEALED_SNAPSHOT = Uint8Array.of(0x73, 0x6d, 0x53, 0x31);

/**
 * What a sealed snapshot is bound to: the document it is of, and the lineage. Lifted into another
 * document or lineage it no longer opens, whatever a checkpoint around it says.
 */
const snapshotAad = (address: DocAddress, lineage: LineageId | undefined) =>
  encodeCbor([
    "syncmesh/doc-snapshot/v1",
    address.table,
    address.key,
    address.column,
    lineage ?? null,
  ]);

/** Whether these bytes are shaped as a sealed snapshot: the marker, an epoch, a nonce and a tag. */
export function isSealedSnapshot(bytes: Uint8Array): boolean {
  if (bytes.length <= SEALED_SNAPSHOT.length) return false;
  if (!SEALED_SNAPSHOT.every((byte, i) => bytes[i] === byte)) return false;
  return epochOf(bytes.subarray(SEALED_SNAPSHOT.length)) !== undefined;
}

/**
 * A snapshot sealed to its partition's newest content key (RFC-0023 §11, gaps U24), so the opaque
 * host that keeps a checkpoint's blob keeps ciphertext. Refused, never sent in the clear, when
 * this device holds no key for the partition.
 */
export function sealSnapshot(
  keys: SealingKeys | undefined,
  partition: PartitionKey,
  address: DocAddress,
  lineage: LineageId | undefined,
  snapshot: Uint8Array,
): Result<Uint8Array, SnapshotUnsealable> {
  const key = keys?.keyFor(partition);
  const epoch = keys?.epochFor(partition);
  if (key === undefined || epoch === undefined)
    return Result.err(
      new SnapshotUnsealable({
        partition,
        message: `this device holds no content key for ${partition}, so it cannot seal the snapshot a checkpoint of it carries`,
      }),
    );
  const sealed = sealPayload(key, snapshot, snapshotAad(address, lineage), epoch);
  const out = new Uint8Array(SEALED_SNAPSHOT.length + sealed.length);
  out.set(SEALED_SNAPSHOT);
  out.set(sealed, SEALED_SNAPSHOT.length);
  return Result.ok(out);
}

/** The snapshot behind a seal, under the epoch it names; refused when it is not one or will not open. */
export function openSnapshot(
  keys: SealingKeys | undefined,
  partition: PartitionKey,
  address: DocAddress,
  lineage: LineageId | undefined,
  sealed: Uint8Array,
): Result<Uint8Array, CheckpointRefused> {
  if (!isSealedSnapshot(sealed))
    return Result.err(
      new CheckpointRefused({
        message: "a sealed partition's checkpoint carries an unsealed snapshot",
      }),
    );
  const payload = sealed.subarray(SEALED_SNAPSHOT.length);
  const epoch = epochOf(payload);
  const key = epoch === undefined ? undefined : keys?.keyAt(partition, epoch);
  if (key === undefined)
    return Result.err(
      new CheckpointRefused({
        message: `this device holds no content key for ${partition} at the epoch the snapshot is sealed under`,
      }),
    );
  return openPayload(key, payload, snapshotAad(address, lineage)).mapError(
    (cause) =>
      new CheckpointRefused({
        message: "the sealed snapshot does not open under its partition's key",
        cause,
      }),
  );
}
