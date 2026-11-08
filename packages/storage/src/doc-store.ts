import type { DocAddress, DocSnapshot, DocStore, StoreFailure } from "@syncmesh/engine";
import type { SeqNum } from "@syncmesh/kernel";

import { inTail, nextState } from "@syncmesh/engine";
import { parseLineageId, parsePeerId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlDriver, SqlValue } from "./driver.js";

import { dialectOf } from "./dialect.js";
import { corrupt, count, decodeEntry, decodeHead, hexOr, idOf, params } from "./doc-rows.js";
import { attempt, inTransaction } from "./sql.js";

export interface SqlDocStoreOptions {
  /** The caller holds the transaction; see `SqlEventStoreOptions.nested`. */
  readonly nested?: boolean;
}

/**
 * The doc log, heads and snapshots (RFC-0023 §6.1–6.2) in the database behind `driver`, beside
 * the event log and the state: `syncmesh_doc_log`/`syncmesh_doc_heads`/`syncmesh_doc_snapshots` on
 * a device, `syncmesh.doc_log`/`syncmesh.doc_heads`/`syncmesh.doc_snapshots` in an app's Postgres.
 * What an engine's `docStore` takes, and `openStores` opens.
 *
 * @example
 * const docs = (await sqlDocStore(driver)).unwrap();
 * const engine = createEngine({ ...options, docStore: docs });
 */
export function sqlDocStore(
  driver: SqlDriver,
  options: SqlDocStoreOptions = {},
): Promise<Result<DocStore, StoreFailure>> {
  const { docs: SQL, migrate } = dialectOf(driver);
  const transaction = <T>(fn: () => Promise<T>): Promise<T> =>
    options.nested === true ? fn() : inTransaction(driver, fn);
  const query = (message: string, sql: string, values: readonly SqlValue[] = []) =>
    attempt(message, () => driver.all(sql, values));
  const entriesOf = (doc: DocAddress) =>
    query("doc entries failed", SQL.selectDocEntries, [doc.table, doc.key, doc.column]).then(
      (rows) => rows.andThen((r) => Result.all(r.map(decodeEntry))),
    );

  const store: DocStore = {
    append: (entries) =>
      attempt("doc append failed", () =>
        transaction(async () => {
          for (const entry of entries) await driver.run(SQL.insertEntry, params(entry));
        }),
      ),
    entries: () =>
      query("doc entries failed", SQL.selectEntries).then((rows) =>
        rows.andThen((r) => Result.all(r.map(decodeEntry))),
      ),
    relineage: (doc, winner, live) =>
      Result.gen(async function* () {
        const held = yield* Result.await(entriesOf(doc));
        const moved = held.flatMap((e) => {
          const next = nextState(e, winner, live);
          return next === e.state ? [] : [[next, e.author, e.seq, e.index] as const];
        });
        yield* Result.await(
          attempt("doc relineage failed", () =>
            transaction(async () => {
              for (const bind of moved) await driver.run(SQL.updateState, bind);
            }),
          ),
        );
        return Result.ok(undefined);
      }),
    refreshHead: (doc, adapter, lineage) =>
      Result.gen(async function* () {
        const held = yield* Result.await(entriesOf(doc));
        const tail = held.filter((e) => e.lineage === lineage && inTail(e.state));
        const bytes = tail.reduce((n, e) => n + e.size, 0);
        const bind = [doc.table, doc.key, doc.column, adapter, hexOr(lineage), tail.length, bytes];
        yield* Result.await(attempt("doc head failed", () => driver.run(SQL.upsertHead, bind)));
        return Result.ok(undefined);
      }),
    entriesOf,
    cover: (doc, cover) =>
      Result.gen(async function* () {
        const where = [doc.table, doc.key, doc.column] as const;
        const moved = [
          ...cover.covered.map((e) => ["covered", e.author, e.seq, e.index] as const),
          ...(cover.failed ?? []).map((e) => ["failed", e.author, e.seq, e.index] as const),
        ];
        const covers = JSON.stringify(Object.fromEntries(cover.covers));
        const head = [...where, cover.adapter, hexOr(cover.lineage), covers, cover.version];
        yield* Result.await(
          attempt("doc cover failed", () =>
            transaction(async () => {
              for (const bind of moved) await driver.run(SQL.updateState, bind);
              await driver.run(SQL.coverHead, [...head, cover.mode, cover.at.epochMilliseconds]);
              await driver.run(SQL.upsertSnapshot, [
                ...where,
                hexOr(cover.lineage),
                cover.snapshot,
              ]);
            }),
          ),
        );
        const held = yield* Result.await(entriesOf(doc));
        const tail = held.filter((e) => e.lineage === cover.lineage && inTail(e.state));
        const bytes = tail.reduce((n, e) => n + e.size, 0);
        yield* Result.await(
          attempt("doc cover failed", () =>
            driver.run(SQL.countTail, [tail.length, bytes, ...where]),
          ),
        );
        return Result.ok(undefined);
      }),
    snapshotOf: (doc) =>
      query("doc snapshot failed", SQL.selectSnapshot, [doc.table, doc.key, doc.column]).then(
        (rows) =>
          rows.andThen((r) => {
            const [row] = r;
            if (row === undefined) return Result.ok(undefined);
            const [lineage, bytes] = row;
            if (!(bytes instanceof Uint8Array))
              return Result.err(corrupt("a snapshot is not bytes"));
            const id = idOf(lineage, parseLineageId);
            if (id.isErr()) return Result.err(id.error);
            return Result.ok<DocSnapshot>({
              bytes,
              ...(id.value !== undefined && { lineage: id.value }),
            });
          }),
      ),
    heads: () =>
      query("doc heads failed", SQL.selectHeads).then((rows) =>
        rows.andThen((r) => Result.all(r.map(decodeHead))),
      ),
    uncoveredFloor: () =>
      query("doc floor failed", SQL.selectUncovered).then((rows) =>
        rows.andThen((r) =>
          Result.all(
            r.map(([author, min]) =>
              Result.gen(function* () {
                const peer = yield* parsePeerId(String(author)).mapError(() => corrupt("author"));
                const lowest = yield* count(min);
                // SAFETY: one below a positive sequence; 0 holds the author back entirely
                return Result.ok([peer, (lowest - 1) as SeqNum] as const);
              }),
            ),
          ).map((pairs) => new Map(pairs)),
        ),
      ),
  };

  if (options.nested === true) return Promise.resolve(Result.ok(store)); // the owner migrated
  return attempt("open failed", () => migrate(driver)).then((opened) => opened.map(() => store));
}
