import type { DerivedRow, DocAddress, MutateError, MutateOptions, Tx } from "@syncmesh/engine";
import type {
  AdapterId,
  Change,
  DocColumns,
  LineageId,
  Procedure,
  SyncEvent,
} from "@syncmesh/kernel";

import { docKey, record } from "@syncmesh/engine";
import { getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AnyAdapter, DocumentAdapter, UpdateRejected } from "./adapter.js";
import type { DocBlobs } from "./blobs.js";
import type { OpenDoc, OpenError } from "./documents.js";
import type { Entry, FlushError } from "./entry.js";
import type { AdapterMissing, NotADocColumn } from "./errors.js";
import type { Derive, DocsEngine } from "./materialise.js";

import { columnAdapter } from "./adapter.js";
import { carry } from "./blobs.js";
import { burstChanges, exportBurst, invalidate } from "./entry.js";
import { DocWriteConflict, FlushRefused, LineageIncomplete } from "./errors.js";
import { listLineages, readLineage } from "./lineages.js";

/**
 * The documents a write edits or replaces, beside its row changes (RFC-0023 §4.3): everything the
 * callback asks for lands in **one** event, the rows and the document updates together.
 */
export interface DocWrites {
  /**
   * Edits the document at `address` inside this write: `edit` runs on its replica — opened for
   * the write when no handle holds it — with the library's own API, and commits like any edit
   * there. What it commits, with whatever the replica held unflushed, rides the write's event.
   */
  readonly change: <D>(address: DocAddress, edit: (doc: D) => void) => void;
  /**
   * Starts a new lineage of the document at `address` from `snapshot` (RFC-0023 §5.3): an import,
   * a reset to a template, a restore of another version. It replaces the lineage winning here, so
   * it wins over every edit made on it; a replace written on top of a version someone else
   * already replaced loses to theirs.
   */
  readonly replace: (address: DocAddress, snapshot: Uint8Array) => void;
}

export type DocWriteError =
  | OpenError
  | FlushError
  | MutateError
  | DocWriteConflict
  | NotADocColumn
  | AdapterMissing
  | UpdateRejected;

/** What a write's callback asked of the documents, in call order. */
interface Asked {
  readonly changes: { readonly address: DocAddress; readonly run: (entry: Entry) => void }[];
  readonly replaces: { readonly address: DocAddress; readonly snapshot: Uint8Array }[];
}

export interface WriteDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  readonly adapters: ReadonlyMap<AdapterId, AnyAdapter>;
  readonly blobs: DocBlobs | undefined;
  readonly fresh: () => bigint;
  readonly open: <D>(address: DocAddress) => Promise<Result<OpenDoc<D>, OpenError>>;
  /** The replica open at `address`, unless it was invalidated: the one a handle just opened shares. */
  readonly held: (address: DocAddress) => Entry | undefined;
  readonly derive: (address: DocAddress) => Derive<unknown> | undefined;
  /** A write at `address` wrote nothing, so the derived values it computed never landed. */
  readonly onFailed?: (address: DocAddress) => void;
}

/** Runs the callback against a recording `Tx` and {@link DocWrites}: what the write is to hold. */
function ask(fn: (tx: Tx, docs: DocWrites) => void) {
  const asked: Asked = { changes: [], replaces: [] };
  const docs: DocWrites = {
    change: <D>(address: DocAddress, edit: (doc: D) => void) =>
      asked.changes.push({
        address,
        run: (entry) => {
          // SAFETY: the replica is the column adapter's document, whose type the caller named
          const doc = entry.doc as D;
          edit(doc);
        },
      }),
    replace: (address, snapshot) => asked.replaces.push({ address, snapshot }),
  };
  return { rows: record((tx) => fn(tx, docs)), asked };
}

/**
 * Checks a `replace()`'s snapshot before anything is written: the column's adapter must read it on
 * a fresh replica, and it must be carriable — inline, or by reference with a blob store.
 */
async function genesisChanges(
  deps: WriteDeps,
  replaces: Asked["replaces"],
  partition: MutateOptions["partition"],
): Promise<Result<readonly Change[], DocWriteError>> {
  const changes: Change[] = [];
  for (const { address, snapshot } of replaces) {
    const adapter = columnAdapter(deps.docs, deps.adapters, address);
    if (adapter.isErr()) return adapter;
    const probe = adapter.value.apply(adapter.value.create(deps.fresh()), [snapshot]);
    if (probe.isErr()) return probe;
    const carried = await carry(adapter.value, [snapshot], deps.blobs, partition);
    if (carried.isErr()) return carried;
    for (const update of carried.value)
      changes.push({
        kind: "doc",
        table: address.table,
        key: address.key,
        column: address.column,
        adapter: adapter.value.id,
        update,
        genesis: true,
      });
  }
  return Result.ok(changes);
}

/**
 * A write of rows and documents as **one** event (RFC-0023 §4.3): the callback records row
 * changes on `tx` and document edits and replaces on `docs`; each edited document is opened (or
 * its open replica shared), edited, and exported, and the rows, the document updates and the
 * geneses go to the engine together. A refused write publishes none of it, and the replicas it
 * edited are invalidated, so their operations are never exported later. A document cannot be
 * both edited and replaced in one write ({@link DocWriteConflict}): the edit would land on the
 * lineage the replace ends.
 */
export async function writeDocs(
  deps: WriteDeps,
  procedure: Procedure,
  fn: (tx: Tx, docs: DocWrites) => void,
  options: MutateOptions = {},
): Promise<Result<SyncEvent, DocWriteError>> {
  const { rows, asked } = ask(fn);
  const replaced = new Set(asked.replaces.map(({ address }) => docKey(address)));
  const both = asked.changes.find(({ address }) => replaced.has(docKey(address)));
  if (both !== undefined)
    return Result.err(
      new DocWriteConflict({
        ...both.address,
        message: "one write cannot both edit and replace a document",
      }),
    );
  const first = asked.changes[0]?.address ?? asked.replaces[0]?.address;
  const partition =
    options.partition ??
    (first === undefined
      ? undefined
      : getRecord(deps.engine.state(), first.table, first.key)?.partition);
  const geneses = await genesisChanges(deps, asked.replaces, partition);
  if (geneses.isErr()) return geneses;
  const handles = new Map<string, OpenDoc<unknown>>();
  const written = await editAndWrite(deps, procedure, rows, asked, geneses.value, handles, {
    ...options,
    ...(partition !== undefined && { partition }),
  });
  for (const handle of handles.values()) await handle.close();
  return written;
}

/** The replicas a write edits, by document. */
type Edited = Map<string, { readonly address: DocAddress; readonly entry: Entry }>;

/**
 * Opens every document the write edits — or shares the replica a handle already holds — keeping
 * each handle in `handles` for the caller to close. Nothing is edited until every open succeeded.
 */
async function openAll(
  deps: WriteDeps,
  asked: Asked,
  handles: Map<string, OpenDoc<unknown>>,
): Promise<Result<Edited, DocWriteError>> {
  const entries: Edited = new Map();
  for (const { address } of asked.changes) {
    const key = docKey(address);
    if (handles.has(key)) continue;
    const opened = await deps.open(address);
    if (opened.isErr()) return Result.err(opened.error);
    handles.set(key, opened.value);
    const entry = deps.held(address);
    if (entry === undefined)
      return Result.err(new FlushRefused({ message: "the document's replica was invalidated" }));
    entries.set(key, { address, entry });
  }
  return Result.ok(entries);
}

/** Edits every document asked for, then writes the one event. */
async function editAndWrite(
  deps: WriteDeps,
  procedure: Procedure,
  rows: readonly Change[],
  asked: Asked,
  geneses: readonly Change[],
  handles: Map<string, OpenDoc<unknown>>,
  options: MutateOptions,
): Promise<Result<SyncEvent, DocWriteError>> {
  const opened = await openAll(deps, asked, handles);
  if (opened.isErr()) return opened;
  const entries = opened.value;
  for (const { address, run } of asked.changes) {
    const held = entries.get(docKey(address));
    if (held !== undefined) run(held.entry);
  }
  const docChanges: Change[] = [];
  const derived: DerivedRow[] = [];
  for (const { address, entry } of entries.values()) {
    const parts = exportBurst(deps.engine, address, entry);
    if (parts.isErr()) return failAll(deps, entries, parts.error);
    const changes = await burstChanges(address, entry, parts.value, deps.blobs, options.partition);
    if (changes.isErr()) return failAll(deps, entries, changes.error);
    docChanges.push(...changes.value);
    const values = deps.derive(address)?.(entry.doc);
    if (values !== undefined) derived.push({ table: address.table, key: address.key, values });
  }
  const written = await deps.engine.mutate(
    procedure,
    (tx) => {
      for (const change of [...rows, ...docChanges, ...geneses]) replay(tx, change);
    },
    {
      ...options,
      ...(derived.length > 0 && { derived: [...(options.derived ?? []), ...derived] }),
    },
  );
  return written.isErr() ? failAll(deps, entries, written.error) : written;
}

/** A refused write: every replica it edited is invalidated, so what it holds is never exported. */
function failAll<E>(deps: WriteDeps, entries: Edited, error: E) {
  for (const { address, entry } of entries.values()) {
    invalidate(entry);
    deps.onFailed?.(address);
  }
  return Result.err(error);
}

/** One recorded change, recorded again on the engine's own `Tx`. */
function replay(tx: Tx, change: Change) {
  switch (change.kind) {
    case "insert":
      return tx.insert(change.table, change.key, change.row);
    case "update":
      return tx.update(change.table, change.key, change.patch);
    case "delete":
      return tx.delete(change.table, change.key);
    case "doc": {
      const { kind: _kind, table, key, ...write } = change;
      return tx.doc(table, key, write);
    }
    // a recording `Tx` writes none: only a fold meets a kind a newer build wrote
    case "unknown":
      return undefined;
  }
}

/** What {@link createWrites} needs beyond {@link WriteDeps}: the procedure a replace is recorded under. */
export interface WritesDeps extends WriteDeps {
  readonly procedure: Procedure;
}

/** The runtime's write surface: rows and documents in one event, replaces, and lineage restores. */
export function createWrites(deps: WritesDeps) {
  const replaceWith = (address: DocAddress, snapshot: Uint8Array, options?: MutateOptions) =>
    writeDocs(deps, deps.procedure, (_tx, writes) => writes.replace(address, snapshot), options);
  return {
    /**
     * Writes rows and documents as **one** event (RFC-0023 §4.3): `fn` records row changes on
     * `tx` and document edits and replaces on `docs`, published together or not at all.
     *
     * @example
     * await documents.mutate(procedure, (tx, docs) => {
     *   tx.insert(notes, id, row);
     *   docs.change<LoroDoc>({ table: notes, key: id, column }, (d) => {
     *     d.getText("body").insert(0, body);
     *     d.commit();
     *   });
     * });
     */
    mutate: (
      procedure: Procedure,
      fn: (tx: Tx, docs: DocWrites) => void,
      options?: MutateOptions,
    ) => writeDocs(deps, procedure, fn, options),
    /**
     * Starts a new lineage of the document at `address` from `snapshot` (RFC-0023 §5.3) — an
     * import, a reset to a template, a restore — as its own event under the runtime's procedure.
     */
    replace: replaceWith,
    /** Every history the document at `address` has had, the winner marked (see {@link DocLineage}). */
    lineages: (address: DocAddress) => listLineages(deps.engine, address),
    /**
     * One lineage of the document at `address` — one that lost to another `replace()` included —
     * rebuilt on a detached replica: read it, diff it, show it; nothing on it is ever flushed.
     */
    openLineage: <D>(address: DocAddress, lineage: LineageId | undefined) =>
      Result.gen(async function* () {
        const adapter: DocumentAdapter<D> = yield* columnAdapter(deps.docs, deps.adapters, address);
        return Result.ok(
          yield* Result.await(
            readLineage(deps.engine, adapter, address, lineage, deps.fresh(), deps.blobs),
          ),
        );
      }),
    /**
     * Brings a lineage that lost back as the document's winner (RFC-0023 §5.3, "recover the other
     * version"): a `replace()` with its snapshot, written on top of the lineage winning here, so
     * it wins and the version it displaces is listed in turn. A lineage this device holds only part
     * of is refused ({@link LineageIncomplete}) rather than published partial.
     */
    restore: (address: DocAddress, lineage: LineageId | undefined, options?: MutateOptions) =>
      Result.gen(async function* () {
        const adapter = yield* columnAdapter(deps.docs, deps.adapters, address);
        const version = yield* Result.await(
          readLineage(deps.engine, adapter, address, lineage, deps.fresh(), deps.blobs),
        );
        if (version.lost + version.missing > 0)
          return Result.err(
            new LineageIncomplete({
              lost: version.lost,
              missing: version.missing,
              message: "this device holds only part of that lineage; nothing was written",
            }),
          );
        return Result.ok(
          yield* Result.await(replaceWith(address, adapter.snapshot(version.value), options)),
        );
      }),
  };
}
