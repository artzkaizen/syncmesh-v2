import type { PartitionKey } from "@syncmesh/kernel";

export interface DownloadBlobOptions {
  /** How long to wait for an answer before giving `undefined`. */
  readonly timeoutMs: number;
}

export interface UploadBlobOptions {
  /**
   * The partition whose byte budget these bytes are billed to (D18). Absent, they share the far
   * end's budget for puts that named none. A claim the far end cannot check — it has seen no row
   * yet — so a quota is a budget, not a permission.
   */
  readonly partition?: PartitionKey;
}

/**
 * The far end would not keep the bytes, and why; nothing was stored either way. `quota`: the
 * partition already holds `used` bytes of a `limit` this put would pass. `ungranted`: a
 * grant-gated room, and this device's grant does not name the partition the put was billed to
 * (D44).
 */
export type BlobRefusal =
  | {
      readonly reason: "quota";
      readonly partition?: PartitionKey;
      readonly limit: number;
      readonly used: number;
    }
  | { readonly reason: "ungranted"; readonly partition: PartitionKey };

/** The far end's answer to a fetch: it holds no bytes under that name. Not the same as silence. */
export const BLOB_MISSING = "missing";

/**
 * Bytes crossing this medium out of band, by hash (D18): what a medium with a store on the far
 * side can carry. A capability, not an obligation — a raw radio has nobody to hand bytes to, so
 * it declares none and `mesh.blobs` answers `NoSuchCapability` rather than pretending (D30).
 */
export interface TransportBlobs {
  /**
   * Offers bytes under their own hash; the far end verifies before it keeps them. Resolves with
   * the refusal when the far end said no, and `undefined` when it kept them — or when it said
   * nothing in time, which is what a far end built before the answer existed does.
   */
  readonly upload: (
    hash: string,
    bytes: Uint8Array,
    options?: UploadBlobOptions,
  ) => Promise<BlobRefusal | undefined>;
  /**
   * Asks for bytes by hash: the bytes, {@link BLOB_MISSING} when the far end said it holds none,
   * or `undefined` when the deadline passed with no answer.
   */
  readonly download: (
    hash: string,
    options: DownloadBlobOptions,
  ) => Promise<Uint8Array | typeof BLOB_MISSING | undefined>;
}
