import type { DocAddress } from "@syncmesh/engine";
import type { AdapterId, DocColumns, Hlc, PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { Identity } from "@syncmesh/wire";

import { hlcOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AnyAdapter, columnAdapter } from "./adapter.js";
import type { Derive, DocsEngine } from "./materialise.js";
import type { SealingKeys } from "./sealed-snapshot.js";

import { installCheckpoint } from "./install.js";
import { produceCheckpoint } from "./materialise.js";
import { createPageDocs } from "./pages.js";

/** What the runtime's checkpoints are made with. */
interface CheckpointDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  readonly adapters: ReadonlyMap<AdapterId, AnyAdapter>;
  readonly fresh: () => bigint;
  readonly now: () => Temporal.Instant;
  readonly derive: (address: DocAddress) => Derive<unknown> | undefined;
  /** Whether the document's partition is sealed, and the keys it seals under. */
  readonly sealing: (address: DocAddress) => readonly [boolean, SealingKeys | undefined];
  readonly adapterAt: (address: DocAddress) => ReturnType<typeof columnAdapter>;
}

/**
 * The runtime's checkpoints (RFC-0023 §5.5, §8.4): one produced from a document, one installed in
 * place of history, and the pair a snapshot's pages carry them in (E30 P5).
 */
export function createCheckpoints(deps: CheckpointDeps) {
  const { engine, fresh, now, derive, sealing, adapterAt } = deps;
  const checkpoint = (address: DocAddress, producer: Identity, at: Hlc) =>
    Result.gen(async function* () {
      const adapter = yield* adapterAt(address);
      return Result.ok(
        yield* Result.await(
          produceCheckpoint(
            engine,
            adapter,
            address,
            producer,
            fresh(),
            at,
            derive(address),
            ...sealing(address),
          ),
        ),
      );
    });

  const install = (wire: Uint8Array, producer: PeerId, snapshot: Uint8Array, address: DocAddress) =>
    Result.gen(async function* () {
      const adapter = yield* adapterAt(address);
      return Result.ok(
        yield* Result.await(
          installCheckpoint(
            engine,
            adapter,
            address,
            wire,
            producer,
            snapshot,
            fresh(),
            now(),
            derive(address),
            ...sealing(address),
          ),
        ),
      );
    });

  return {
    checkpoint,
    install,
    /** The documents behind snapshot pages, signed as `producer`. */
    pages: (producer: Identity) =>
      createPageDocs(
        {
          engine,
          docs: deps.docs,
          canOpen: (head) => deps.adapters.has(head.adapter),
          checkpoint,
          install,
          at: () => hlcOf(now().epochMilliseconds, 0),
        },
        producer,
      ),
  };
}
