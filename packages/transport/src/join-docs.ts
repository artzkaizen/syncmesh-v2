import type { KeyedRecord } from "@syncmesh/kernel";

import {
  encodeSnapshotPage,
  type PageCheckpoint,
  type PageDocs,
  type SnapshotPage,
} from "@syncmesh/wire";

import { DEFAULT_MAX_FRAME_BYTES } from "./framing.js";

/**
 * The documents behind a snapshot's rows (RFC-0023 §5.5, §8.4; E30 P5): what a device with a
 * document runtime puts in the pages it serves, and does with the ones it takes. A document
 * column's updates sit in events compaction removes once a snapshot covers them, so rows alone
 * cannot stand for them; a checkpoint per document can.
 */
export interface SnapshotDocs {
  /**
   * The checkpoint of each document of `rows` this device holds anything of, and whether it made
   * one for every such document (`complete`): one it could not sign or materialise leaves the page
   * incomplete, and a joiner below a floor then adopts no coverage for it.
   */
  readonly serve: (rows: readonly KeyedRecord[]) => Promise<PageDocs>;
  /**
   * Installs the checkpoints a whole snapshot carried, after its rows; `true` once this device
   * holds every one of those documents at least as far as its checkpoint covers.
   */
  readonly install: (checkpoints: readonly PageCheckpoint[]) => Promise<boolean>;
}

/**
 * The most a page spends on its documents' checkpoints: half a frame, so a page of rows and
 * checkpoints still travels as one frame on every link ({@link DEFAULT_MAX_FRAME_BYTES}).
 */
export const PAGE_DOCS_BUDGET = DEFAULT_MAX_FRAME_BYTES / 2;

/**
 * A page of `rows` and as many of `docs`' checkpoints as fit {@link PAGE_DOCS_BUDGET}, in the
 * order given. One left out makes the page incomplete: a joiner below a floor then adopts nothing
 * for it rather than miss the document that did not fit.
 */
export function fittedPage(rows: readonly KeyedRecord[], docs: PageDocs): Uint8Array {
  let spent = 0;
  const kept = docs.checkpoints.filter((c) => {
    const size = c.checkpoint.length + c.snapshot.length;
    if (spent + size > PAGE_DOCS_BUDGET) return false;
    spent += size;
    return true;
  });
  const complete = docs.complete && kept.length === docs.checkpoints.length;
  return encodeSnapshotPage({ rows, docs: { checkpoints: kept, complete } });
}

/**
 * The documents follow the rows they are columns of, since a checkpoint is checked against the
 * lineage its row's cell names. Whether this device now holds every document the pages stood
 * for: none were there to hold when the pages were complete and carried no checkpoint.
 */
export const installDocs = (docs: SnapshotDocs | undefined, carried: PageDocs): Promise<boolean> =>
  docs === undefined || carried.checkpoints.length === 0
    ? Promise.resolve(carried.complete)
    : docs.install(carried.checkpoints);

/**
 * Every checkpoint a snapshot's pages carried, and whether each page said it carried all of its
 * rows' documents; never complete for a device that takes no documents (`takes` false).
 */
export const carriedDocs = (pages: readonly SnapshotPage[], takes: boolean): PageDocs => ({
  checkpoints: pages.flatMap((page) => [...(page.docs?.checkpoints ?? [])]),
  complete: takes && pages.every((page) => page.docs?.complete === true),
});
