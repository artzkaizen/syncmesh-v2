import type { DocAddress, StoreFailure } from "@syncmesh/engine";
import type { LineageId, Stamp } from "@syncmesh/kernel";

import { getRecord, readLineageCell, winningLineage } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocumentAdapter, UpdateRejected } from "./adapter.js";
import type { DocBlobs } from "./blobs.js";
import type { DocsEngine } from "./materialise.js";

import { resolveTail } from "./blobs.js";
import { load } from "./materialise.js";

/**
 * One history of a document (RFC-0023 §5.3): the root, or what a `replace()` started. The winner
 * is the one `open()` edits; every other lost, and its updates are kept as `orphaned` so an app
 * can show it and offer it back ({@link Documents.restore}).
 */
export interface DocLineage {
  /** Absent is the root lineage. */
  readonly lineage?: LineageId;
  /** The lineage its genesis replaced; absent for the root, and for a genesis that replaced the root. */
  readonly parent?: LineageId;
  /**
   * Its genesis's stamp; absent for the root, and for a genesis the lineage cell no longer holds
   * because a later replace settled the walk past it (gaps U21).
   */
  readonly stamp?: Stamp;
  readonly winning: boolean;
  /** How many of its updates the doc log holds, its genesis included. */
  readonly updates: number;
}

/** The DocsEngine members the lineage readers use. */
export type LineageEngine = Pick<DocsEngine, "state" | "docLogOf" | "docLineageLog">;

/**
 * Every lineage of the document at `address`: those its lineage cell holds and those its doc log
 * holds updates of, the root included when it has any, oldest genesis first, the root before all.
 */
export function listLineages(
  engine: LineageEngine,
  address: DocAddress,
): Promise<Result<readonly DocLineage[], StoreFailure>> {
  return Result.gen(async function* () {
    const cell = readLineageCell(
      getRecord(engine.state(), address.table, address.key)?.cells.get(address.column)?.value,
    );
    const winner = winningLineage(cell.geneses, cell.settled);
    const entries = yield* Result.await(engine.docLogOf(address));
    const counts = new Map<LineageId | undefined, number>();
    for (const e of entries) counts.set(e.lineage, (counts.get(e.lineage) ?? 0) + 1);
    const byLineage = new Map(cell.geneses.map((g) => [g.lineage, g]));
    const named = new Set<LineageId | undefined>([
      ...cell.geneses.map((g) => g.lineage),
      ...counts.keys(),
      winner,
    ]);
    const lineages = [...named].map((lineage): DocLineage => {
      const genesis = lineage === undefined ? undefined : byLineage.get(lineage);
      return {
        ...(lineage !== undefined && { lineage }),
        ...(genesis?.parent !== undefined && { parent: genesis.parent }),
        ...(genesis !== undefined && { stamp: genesis.stamp }),
        winning: lineage === winner,
        updates: counts.get(lineage) ?? 0,
      };
    });
    const at = (l: DocLineage) => l.stamp?.hlc[0].epochMilliseconds ?? -1;
    return Result.ok(
      lineages.sort((a, b) =>
        a.lineage === undefined ? -1 : b.lineage === undefined ? 1 : at(a) - at(b),
      ),
    );
  });
}

/** A lineage rebuilt on a detached replica: never flushed, never edited by the runtime. */
export interface LineageVersion<D> {
  readonly value: D;
  readonly lineage?: LineageId;
  /** Updates of it the adapter could not read, left out (RFC-0023 §10). */
  readonly failed: number;
  /** Blob-carried updates of it no carrier holds yet, left out. */
  readonly missing: number;
}

/**
 * Rebuilds one lineage of the document at `address` — a version that lost to another `replace()`
 * included — from every update the doc log holds of it, on a fresh replica nothing flushes.
 */
export function readLineage<D>(
  engine: LineageEngine,
  adapter: DocumentAdapter<D>,
  address: DocAddress,
  lineage: LineageId | undefined,
  replica: bigint,
  blobs: DocBlobs | undefined,
): Promise<Result<LineageVersion<D>, StoreFailure | UpdateRejected>> {
  return Result.gen(async function* () {
    const updates = yield* Result.await(engine.docLineageLog(address, lineage));
    const tail = await resolveTail({ updates }, blobs);
    const loaded = yield* load(adapter, tail, replica);
    return Result.ok({
      value: loaded.doc,
      ...(lineage !== undefined && { lineage }),
      failed: loaded.failed.length,
      missing: loaded.missing.length,
    });
  });
}
