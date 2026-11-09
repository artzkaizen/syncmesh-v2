import type { DocAddress, DocHead } from "@syncmesh/engine";
import type { DocColumns, Hlc, KeyedRecord, PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Identity, PageCheckpoint, PageDocs } from "@syncmesh/wire";

import { docKey } from "@syncmesh/engine";
import { decodeCheckpoint } from "@syncmesh/wire";

import type { DocsEngine, ProducedCheckpoint } from "./materialise.js";

/**
 * The documents behind snapshot pages (RFC-0023 §5.5, §8.4; E30 P5): a checkpoint for each
 * document of the rows a page carries, and the install of the ones a joiner takes, so a device
 * joining by state is handed its documents by the transport rather than by the app.
 *
 * @module
 */

/** What the pages are built and installed through: the runtime's own checkpoint and install. */
export interface PageDocsDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  /** Whether this device holds the adapter a head names, and so can checkpoint its document. */
  readonly canOpen: (head: DocHead) => boolean;
  readonly checkpoint: (
    address: DocAddress,
    producer: Identity,
    at: Hlc,
  ) => Promise<Result<ProducedCheckpoint, unknown>>;
  readonly install: (
    wire: Uint8Array,
    producer: PeerId,
    snapshot: Uint8Array,
    address: DocAddress,
  ) => Promise<Result<unknown, unknown>>;
  /** The stamp a checkpoint is signed at. */
  readonly at: () => Hlc;
}

/**
 * The two halves a join exchange takes (`SnapshotDocs` in `@syncmesh/transport`), signing as
 * `producer`.
 *
 * Serving checkpoints every document of the page's rows this device holds a head for — anything
 * folded at all — materialising it first, as {@link produceCheckpoint} does. One whose adapter is
 * missing here, or whose checkpoint fails (operations pending, a sealed partition with no key),
 * leaves the page `complete: false`.
 *
 * Installing runs each checkpoint through `install` — the full check of {@link installCheckpoint},
 * version re-derived from the bytes — and answers whether every document's head now covers at
 * least what its checkpoint covers, on the lineage it was of. A checkpoint refused because this
 * device already holds a newer snapshot still counts: the head is past it.
 */
export function createPageDocs(deps: PageDocsDeps, producer: Identity) {
  const { engine, docs } = deps;
  return {
    serve: async (rows: readonly KeyedRecord[]): Promise<PageDocs> => {
      const heads = await engine.docHeads();
      if (heads.isErr()) return { checkpoints: [], complete: false };
      const held = new Map(heads.value.map((head) => [docKey(head), head]));
      const checkpoints: PageCheckpoint[] = [];
      let complete = true;
      for (const { table, key } of rows)
        for (const column of docs.get(table)?.keys() ?? []) {
          const head = held.get(docKey({ table, key, column }));
          if (head === undefined) continue;
          if (!deps.canOpen(head)) {
            complete = false;
            continue;
          }
          const made = await deps.checkpoint({ table, key, column }, producer, deps.at());
          if (made.isErr()) {
            complete = false;
            continue;
          }
          const { signed, snapshot } = made.value;
          checkpoints.push({ producer: producer.peerId, checkpoint: signed.wire, snapshot });
        }
      return { checkpoints, complete };
    },
    install: async (checkpoints: readonly PageCheckpoint[]): Promise<boolean> => {
      const claimed = checkpoints.flatMap(({ producer: by, checkpoint, snapshot }) => {
        const decoded = decodeCheckpoint(checkpoint, by);
        return decoded.isOk()
          ? [{ by, checkpoint, snapshot, claim: decoded.value.checkpoint }]
          : [];
      });
      for (const { by, checkpoint, snapshot, claim } of claimed) {
        const { table, key, column } = claim;
        await deps.install(checkpoint, by, snapshot, { table, key, column });
      }
      const heads = await engine.docHeads();
      if (heads.isErr() || claimed.length < checkpoints.length) return false;
      const held = new Map(heads.value.map((head) => [docKey(head), head]));
      return claimed.every(({ claim }) => {
        const head = held.get(docKey(claim));
        if (head === undefined || head.version === undefined || head.lineage !== claim.lineage)
          return false;
        return [...claim.covers].every(([author, seq]) => (head.covers.get(author) ?? 0) >= seq);
      });
    },
  };
}
