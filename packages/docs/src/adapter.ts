import type { DocAddress } from "@syncmesh/engine";
import type { AdapterId, DocColumns } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import { AdapterMissing, NotADocColumn } from "./errors.js";

/**
 * The bounds an adapter holds every document to (RFC-0023 §5.4, §8.2, §10). Exceeding one is a
 * value — a refused flush, a `failed` update, a materialisation — never a crash.
 */
export interface DocLimits {
  /** The largest update a flush exports or an import accepts. RFC-0023 §5.4's inline bound. */
  readonly maxUpdateBytes: number;
  /** The largest snapshot a document may grow to; past it, edits are refused. */
  readonly maxSnapshotBytes: number;
  /** Tail length at which a document is materialised and its log may be trimmed (§8.2). */
  readonly snapshotEvery: number;
  /** Tail bytes at which the same happens. */
  readonly snapshotEveryBytes: number;
}

/** RFC-0023's numbers: 64 KiB inline, 200 updates or 256 KiB of tail, 16 MiB of document. */
export const DEFAULT_LIMITS = {
  maxUpdateBytes: 64 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  snapshotEvery: 200,
  snapshotEveryBytes: 256 * 1024,
} as const satisfies DocLimits;

/** The adapter could not take these bytes: malformed, oversized, or from another library. */
export class UpdateRejected extends TaggedError("UpdateRejected")<{
  adapter: string;
  message: string;
  cause?: unknown;
}> {}

/**
 * A CRDT library behind syncmesh's document columns (RFC-0023 §2.8). The library's own document
 * type is `D`, handed to the app untouched; everything here is what syncmesh needs to carry and
 * store it, and nothing that edits it.
 *
 * Every member is total: foreign bytes come back as {@link UpdateRejected}, never as a throw.
 * Two runtimes implementing one adapter id must write one `version` for one history, byte for
 * byte; `snapshot` and `since` must agree as documents — import to the same version and value —
 * since a library may lay out the same document differently (`conformance/loro-vectors.json`).
 */
export interface DocumentAdapter<D> {
  readonly id: AdapterId;
  readonly limits: DocLimits;
  /** An empty document whose own operations are attributed to `replica` (see `replicaId`). */
  readonly create: (replica: bigint) => D;
  /** Imports updates or snapshots, in any order and any number of times. `true` when it changed the document. */
  readonly apply: (doc: D, updates: readonly Uint8Array[]) => Result<boolean, UpdateRejected>;
  /**
   * Whether imported operations wait on others the document has not seen. A snapshot leaves them
   * out, so a document with any is never materialised.
   */
  readonly pending: (doc: D) => boolean;
  /** The whole document as one importable snapshot. */
  readonly snapshot: (doc: D) => Uint8Array;
  /** The document's version, in the adapter's own encoding; what `since` reads back. */
  readonly version: (doc: D) => Uint8Array;
  /** One update holding every operation the document has past `version`. */
  readonly since: (doc: D, version: Uint8Array) => Result<Uint8Array, UpdateRejected>;
  /** Calls `listener` after each local commit; the returned function stops it. */
  readonly watchLocal: (doc: D, listener: () => void) => () => void;
}

/** A document adapter of any library, as a registry holds it. */
// oxlint-disable-next-line typescript/no-explicit-any -- the registry is heterogeneous by design; each open() names its D
export type AnyAdapter = DocumentAdapter<any>;

/** The adapter id a document column declares, whether or not this runtime holds the adapter. */
export function resolveAdapterId(
  docs: DocColumns,
  address: DocAddress,
): Result<AdapterId, NotADocColumn> {
  const id = docs.get(address.table)?.get(address.column);
  return id === undefined
    ? Result.err(
        new NotADocColumn({
          table: address.table,
          column: address.column,
          message: "the mesh declares no document column there",
        }),
      )
    : Result.ok(id);
}

/** The adapter a document column declares, as this runtime holds it. */
export function columnAdapter(
  docs: DocColumns,
  adapters: ReadonlyMap<AdapterId, AnyAdapter>,
  address: DocAddress,
): Result<AnyAdapter, NotADocColumn | AdapterMissing> {
  return resolveAdapterId(docs, address).andThen((id) => {
    const adapter = adapters.get(id);
    return adapter === undefined
      ? Result.err(new AdapterMissing({ adapter: id, message: `no adapter for ${id}` }))
      : Result.ok(adapter);
  });
}
