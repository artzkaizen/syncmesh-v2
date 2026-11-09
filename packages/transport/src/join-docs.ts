import type { KeyedRecord } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
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
   * Installs the checkpoints a whole snapshot carried, after its `rows`; `true` once this device
   * holds every one of those documents at least as far as its checkpoint covers, and the pages
   * carried a checkpoint for every document of `rows` that names a lineage. The sender's
   * `complete` is a claim this checks rather than takes.
   */
  readonly install: (
    rows: readonly KeyedRecord[],
    checkpoints: readonly PageCheckpoint[],
  ) => Promise<boolean>;
}

/** What a page carries of its documents when serving them failed: nothing, and not complete. */
export const NO_DOCS = { checkpoints: [], complete: false } satisfies PageDocs;

/**
 * `docs.serve(rows)`, or no checkpoints and an incomplete page when it rejects: the pages still go
 * out, so the joiner's exchange closes, and it adopts no floor for the documents it was not sent.
 */
export const servedDocs = (docs: SnapshotDocs, rows: readonly KeyedRecord[]): Promise<PageDocs> =>
  Result.tryPromise(() => docs.serve(rows)).then((served) => served.unwrapOr(NO_DOCS));

/**
 * The most a page spends on its documents' checkpoints: half a frame, so a page of rows and
 * checkpoints still travels as one frame on every link ({@link DEFAULT_MAX_FRAME_BYTES}).
 */
export const PAGE_DOCS_BUDGET = DEFAULT_MAX_FRAME_BYTES / 2;

/**
 * The most an encoded page may be: a frame less room for the `snap-chunk` header around it and the
 * session's seal (`SEAL_OVERHEAD`), with plenty to spare.
 */
export const PAGE_FRAME_BYTES = DEFAULT_MAX_FRAME_BYTES - 64 * 1024;

/**
 * A page of `rows` and as many of `docs`' checkpoints as fit {@link PAGE_DOCS_BUDGET}, in the
 * order given, then fewer from the end while the encoded page is past {@link PAGE_FRAME_BYTES}
 * (large rows leave less room). One left out makes the page incomplete: a joiner below a floor
 * then adopts nothing for it rather than miss the document that did not fit.
 */
export function fittedPage(rows: readonly KeyedRecord[], docs: PageDocs): Uint8Array {
  let spent = 0;
  const kept = docs.checkpoints.filter((c) => {
    const size = c.checkpoint.length + c.snapshot.length;
    if (spent + size > PAGE_DOCS_BUDGET) return false;
    spent += size;
    return true;
  });
  const encode = () =>
    encodeSnapshotPage({
      rows,
      docs: {
        checkpoints: kept,
        complete: docs.complete && kept.length === docs.checkpoints.length,
      },
    });
  let page = encode();
  while (page.length > PAGE_FRAME_BYTES && kept.length > 0) {
    kept.pop();
    page = encode();
  }
  return page;
}

/**
 * The documents follow the rows they are columns of, since a checkpoint is checked against the
 * lineage its row's cell names; the checkpoints of an incomplete page are installed too. Whether
 * this device now holds every document the pages stood for: pages that said they were incomplete
 * stand for none, and a device that takes no documents holds none.
 */
const installDocs = async (
  docs: SnapshotDocs | undefined,
  rows: readonly KeyedRecord[],
  carried: PageDocs,
): Promise<boolean> =>
  docs !== undefined && (await docs.install(rows, carried.checkpoints)) && carried.complete;

/**
 * Every checkpoint a snapshot's pages carried, and whether each page said it carried all of its
 * rows' documents; never complete for a device that takes no documents (`takes` false).
 */
export const carriedDocs = (pages: readonly SnapshotPage[], takes: boolean): PageDocs => ({
  checkpoints: pages.flatMap((page) => [...(page.docs?.checkpoints ?? [])]),
  complete: takes && pages.every((page) => page.docs?.complete === true),
});

/**
 * Installs the documents the pages carried, then, when the adoption was `gated` on them and they
 * all held, runs `adopt`: the coverage after the documents it waited on. `adopt` installs no rows,
 * so only the store refuses it; nothing to adopt is `Ok(undefined)`.
 */
export async function adoptAfterDocs<T, E>(
  docs: SnapshotDocs | undefined,
  rows: readonly KeyedRecord[],
  carried: PageDocs,
  gated: boolean,
  adopt: () => Promise<Result<T, E>>,
): Promise<Result<T | undefined, E>> {
  const held = await installDocs(docs, rows, carried);
  return held && gated ? adopt() : Result.ok(undefined);
}
