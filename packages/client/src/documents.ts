import type { AnyAdapter, BackgroundError, DocBlobs, Documents, Pacing } from "@syncmesh/docs";
import type { Engine } from "@syncmesh/engine";
import type { PartitionKey, Procedure } from "@syncmesh/kernel";
import type { BlobHash, BlobStore } from "@syncmesh/storage";

import { BlobUnavailable, createDocuments } from "@syncmesh/docs";
import { getRecord } from "@syncmesh/kernel";
import { Result, omitUndefined } from "@syncmesh/result";
import { createDerivers } from "@syncmesh/schema";
import { BlobNotFound, isBlobHash } from "@syncmesh/storage";

import type { Blobs } from "./blobs.js";
import type { BootOptions } from "./boot.js";
import type { RunningTransports } from "./transports.js";

import { docColumns } from "./boot.js";

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

/** What a mesh's blob-carried document updates travel over: its blob surface, its cache, its links. */
export interface DocCarriers {
  readonly blobs: Blobs;
  readonly store: BlobStore;
  readonly links: Pick<RunningTransports, "withBlobs" | "online" | "onLinkEvent">;
}

/** A mesh's document runtime, and how it stops. */
export interface MeshDocsRuntime {
  readonly documents: Documents;
  /** Sends every burst still waiting on its pacing and every blob still waiting on a carrier, then stops. */
  readonly stop: () => Promise<void>;
}

/**
 * The runtime over a mesh's engine, with the schema's document columns and derive functions — the
 * same map the engine and the validator were booted with, so the three never disagree. Absent
 * when the mesh was given no `documents`, or its schema declares no document column.
 */
export function openDocuments(
  engine: Engine,
  schema: BootOptions["schema"] & Parameters<typeof createDerivers>[0],
  options: MeshDocuments | undefined,
  carriers: DocCarriers,
): MeshDocsRuntime | undefined {
  const docs = docColumns(schema);
  if (options === undefined || docs === undefined) return undefined;
  const carry = docBlobs(engine, carriers, options.onError);
  const documents = createDocuments({
    engine,
    adapters: options.adapters,
    docs,
    procedure: DOC_EDIT,
    derive: createDerivers(schema),
    blobs: carry.blobs,
    ...omitUndefined({
      pacing: options.pacing,
      autoMaterialise: options.autoMaterialise,
      rederiveAtStart: options.rederiveAtStart,
      onError: options.onError,
    }),
  });
  return {
    documents,
    stop: async () => {
      await documents.flush();
      documents.stop();
      await carry.stop();
    },
  };
}

/**
 * The mesh's blob surface as the document runtime takes it (RFC-0023 §5.4, D18): a burst past the
 * inline bound travels as a blob the mesh offers to its transports, and one that arrived by
 * reference is fetched.
 *
 * Offline is how a document is written too, so a burst put while no carrier is up is kept in this
 * device's store and is not a refusal — and it is offered again each time a link is proven, until
 * one carrier took it. A device that restarts re-offers, on its first link, every blob-carried
 * update it authored that its store still holds as its own, since which of them a carrier took is
 * not kept across a restart.
 */
function docBlobs(
  engine: Engine,
  { blobs, store, links }: DocCarriers,
  onError: MeshDocuments["onError"],
) {
  const waiting = new Map<BlobHash, PartitionKey | undefined>();
  let seeded = false;
  let offering = Promise.resolve();
  let stopped = false;
  const carrierUp = () => links.withBlobs().some((t) => links.online(t) === true);

  /** Every blob-carried update this device authored, by its row's partition: what a restart re-offers. */
  const authored = async () => {
    const log = await engine.docLog();
    if (log.isErr()) return onError?.(log.error);
    for (const entry of log.value) {
      if (entry.author !== engine.peerId || entry.blob === undefined || !isBlobHash(entry.blob))
        continue;
      if ((await store.origin(entry.blob)) !== "mine") continue;
      waiting.set(entry.blob, getRecord(engine.state(), entry.table, entry.key)?.partition);
    }
  };

  const offer = async () => {
    if (!seeded) {
      seeded = true;
      await authored();
    }
    for (const [hash, partition] of waiting) {
      if (stopped || !carrierUp()) return;
      const held = await store.get(hash);
      // gone from this device's store: nothing is left here to offer
      if (held.isErr()) {
        waiting.delete(hash);
        continue;
      }
      const put = await blobs.put(held.value, partition === undefined ? {} : { partition });
      if (put.isOk()) waiting.delete(hash);
      else if (put.error._tag !== "NoSuchCapability")
        onError?.(
          new BlobUnavailable({
            message:
              "a carrier refused a document update's blob; it is offered again on the next link",
            cause: put.error,
          }),
        );
    }
  };

  // the relay says a link is proven just before it reports itself up: offer once it has
  const off = links.onLinkEvent((event) => {
    if (event.kind !== "proven") return;
    offering = offering
      .then(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
      .then(offer);
  });

  const carried: DocBlobs = {
    put: async (bytes, put) => {
      const partition = put?.partition;
      if (carrierUp()) {
        const stored = await blobs.put(bytes, put);
        if (stored.isOk() || stored.error._tag !== "NoSuchCapability") return stored;
      }
      const kept = await store.put(bytes);
      if (kept.isOk()) waiting.set(kept.value, partition);
      return kept;
    },
    // the wire checked the change's hash is sha-256 hex; one that is not names no blob anyone holds
    fetch: async (hash) =>
      isBlobHash(hash)
        ? blobs.fetch(hash)
        : Result.err(new BlobNotFound({ hash, message: "not a blob hash" })),
  };

  return {
    blobs: carried,
    stop: async () => {
      off();
      stopped = true;
      await offering;
    },
  };
}
