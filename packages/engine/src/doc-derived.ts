import type { LineageId } from "@syncmesh/kernel";

import { docLineage, getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocAddress, DocEntryRef, DocStore } from "./doc-log.js";
import type { DocBindings } from "./doc-path.js";
import type { DerivedRow } from "./state-store.js";

import { docEntryId } from "./doc-log.js";
import { StoreFailure, orThrow } from "./store.js";

/**
 * What a row's derived values were computed from (RFC-0023 §16.4): the document, the lineage it
 * won on, and the `tail` entries of that lineage the document held.
 */
export interface DerivedFrom {
  readonly doc: DocAddress;
  readonly lineage?: LineageId;
  readonly includes: readonly DocEntryRef[];
}

/**
 * Whether `doc` holds no `tail` entry of `lineage` that derived values computed with `includes`
 * left out. One left was folded after the document was read — a flush that wrote newer derived
 * values, or an edit the next materialisation or derive covers — so those values would be older
 * than the document. A cover's own covered entries are no longer `tail` once it commits.
 */
export function coversTail(
  docStore: DocStore,
  doc: DocAddress,
  lineage: LineageId | undefined,
  includes: readonly DocEntryRef[] = [],
): Promise<Result<boolean, StoreFailure>> {
  const included = new Set(includes.map(docEntryId));
  return docStore
    .entriesOf(doc)
    .then((read) =>
      read.map((entries) =>
        entries.every(
          (e) => e.state !== "tail" || e.lineage !== lineage || included.has(docEntryId(e)),
        ),
      ),
    );
}

/**
 * `DocApi.writeDerived`'s transaction: the row's values, written only while `from` still
 * describes the document, then a `derive` fold batch naming the row. `false` when it no longer
 * does and nothing was written.
 */
export async function writeDerived(
  bindings: DocBindings,
  docStore: DocStore,
  row: DerivedRow,
  from: DerivedFrom,
): Promise<Result<boolean, StoreFailure>> {
  const done = await Result.tryPromise({
    try: () =>
      bindings.atomically(async (scoped) => {
        const store = scoped.docs ?? docStore;
        const { doc } = from;
        const winner = docLineage(getRecord(bindings.getState(), doc.table, doc.key), doc.column);
        const current =
          winner === from.lineage &&
          orThrow(await coversTail(store, doc, from.lineage, from.includes));
        if (current) await bindings.derive([row], scoped);
        return current;
      }),
    catch: (cause) =>
      cause instanceof StoreFailure
        ? cause
        : new StoreFailure({ message: "the derived write's transaction failed", cause }),
  });
  if (done.isOk() && done.value) bindings.notifyDerived([row]);
  return done;
}
