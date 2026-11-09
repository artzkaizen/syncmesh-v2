import type { AnyAdapter, BackgroundError, DocBlobs, Documents, Pacing } from "@syncmesh/docs";
import type { Engine } from "@syncmesh/engine";
import type { Procedure } from "@syncmesh/kernel";

import { createDocuments } from "@syncmesh/docs";
import { Result, omitUndefined } from "@syncmesh/result";
import { createDerivers } from "@syncmesh/schema";
import { BlobNotFound, hashOf, isBlobHash } from "@syncmesh/storage";

import type { Blobs } from "./blobs.js";
import type { BootOptions } from "./boot.js";

import { docColumns } from "./boot.js";
import { NoSuchCapability } from "./errors.js";

/**
 * The document runtime a mesh runs (RFC-0023 §4.3, §8): the adapters this device can open its
 * document columns with, and how it paces and materialises them. Absent, document columns still
 * fold, are kept and are forwarded — the `adapter-missing` mode a relay runs — and none can be
 * opened here.
 */
export interface MeshDocuments {
  /** One per adapter id the schema's document columns name; a column whose adapter is absent cannot be opened (§10). */
  readonly adapters: readonly AnyAdapter[];
  /** How local edits are paced into events; RFC-0023 §5.4's 300 ms idle, 1 s at most, by default. */
  readonly pacing?: Pacing;
  /** Materialise a document once its tail passes the adapter's bound (§8.2). On by default. */
  readonly autoMaterialise?: boolean;
  /** Recompute every row's derived columns once at start (gaps U25). On by default. */
  readonly rederiveAtStart?: boolean;
  /** Where a failed paced flush, materialisation or derive goes. */
  readonly onError?: (error: BackgroundError) => void;
}

/** The procedure every flush of an open document is recorded under. */
// SAFETY: a fixed system procedure name; the underscore keeps it out of an app's own namespace
const DOC_EDIT = "_docs.edit" as Procedure;

/**
 * The runtime over a mesh's engine, with the schema's document columns and derive functions — the
 * same map the engine and the validator were booted with, so the three never disagree. Absent
 * when the mesh was given no `documents`, or its schema declares no document column.
 */
export function openDocuments(
  engine: Engine,
  schema: BootOptions["schema"] & Parameters<typeof createDerivers>[0],
  options: MeshDocuments | undefined,
  blobs: Blobs | undefined,
): Documents | undefined {
  const docs = docColumns(schema);
  if (options === undefined || docs === undefined) return undefined;
  return createDocuments({
    engine,
    adapters: options.adapters,
    docs,
    procedure: DOC_EDIT,
    derive: createDerivers(schema),
    ...omitUndefined({
      pacing: options.pacing,
      autoMaterialise: options.autoMaterialise,
      rederiveAtStart: options.rederiveAtStart,
      onError: options.onError,
      blobs: blobs === undefined ? undefined : docBlobs(blobs),
    }),
  });
}

/** Sends every burst still waiting on its pacing, then stops the runtime: what a mesh does as it stops. */
export async function stopDocuments(docs: Documents) {
  await docs.flush();
  docs.stop();
}

/**
 * The mesh's blob surface as the document runtime takes it: a burst past the inline bound travels
 * as a blob the mesh offers to its transports, and one that arrived by reference is fetched (D18).
 */
const docBlobs = (blobs: Blobs): DocBlobs => ({
  // offline is how a document is written too: the bytes are in this device's store either way,
  // and no transport to offer them to yet is not a refusal
  put: async (bytes, put) => {
    const stored = await blobs.put(bytes, put);
    return stored.isErr() && stored.error instanceof NoSuchCapability
      ? Result.ok(hashOf(bytes))
      : stored;
  },
  // the wire checked the change's hash is sha-256 hex; one that is not names no blob anyone holds
  fetch: async (hash) =>
    isBlobHash(hash)
      ? blobs.fetch(hash)
      : Result.err(new BlobNotFound({ hash, message: "not a blob hash" })),
});
