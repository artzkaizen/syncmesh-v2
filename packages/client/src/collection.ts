import type { Engine, StoreFailure, StoredEvent, Tx } from "@syncmesh/engine";
import type {
  CellValue,
  MergeSpec,
  PeerId,
  Procedure,
  Row as WireCells,
  RowKey,
} from "@syncmesh/kernel";
import type { Operation } from "@syncmesh/policy";
import type { InsertRow, Row, Table } from "@syncmesh/schema";

import { EmptyMutation, PolicyDenied } from "@syncmesh/engine";
import { readRows, readRowsIn } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { checkRow, fromWireRow, rowKeyText, toWireRow, withNulls } from "@syncmesh/schema";
import { bytesEqual } from "@syncmesh/wire";

import type { Placement } from "./context.js";
import type { HistoryError, WriteError } from "./errors.js";
import type { Revision } from "./history.js";
import type { Visible } from "./live-query.js";
import type { ListOptions, QueryDescriptor } from "./query.js";

import { NoSuchRow } from "./errors.js";
import { rowHistory } from "./history.js";
import { compareRows, matches, specOf } from "./query.js";

/** The value of the table's primary key column. */
export type KeyOf<T extends Table> = Row<T>[T["primaryKey"]];

/** A mutable copy of the row, handed to `update`'s updater; what it changes becomes the patch. */
export type Draft<T extends Table> = { -readonly [K in keyof Row<T>]: Row<T>[K] };

/** What `update` accepts: the columns to set, or an updater over a draft of the current row. */
export type Update<T extends Table> = Partial<Row<T>> | ((draft: Draft<T>) => void);

/** A collection speaks REST: `list` / `get` / `create` / `update` / `delete`, plus `query` for live results. */
export interface Collection<T extends Table> {
  /** One event in the table's instance; omitted nullable columns are written as `null`. Recorded as `<table>.insert` — the wire's word for a POST. */
  readonly create: (row: InsertRow<T>) => Promise<Result<Row<T>, WriteError>>;
  /** Writes only the columns whose value differs from the row held; nothing changed is `EmptyMutation`. */
  readonly update: (key: KeyOf<T>, change: Update<T>) => Promise<Result<Row<T>, WriteError>>;
  readonly delete: (key: KeyOf<T>) => Promise<Result<void, WriteError>>;
  readonly get: (key: KeyOf<T>) => Row<T> | undefined;
  /** The visible rows now — filtered, ordered, windowed. One-shot; `query` is the live form. */
  readonly list: (options?: ListOptions<T>) => readonly Row<T>[];
  readonly can: (op: Operation, row?: Row<T>) => boolean;
  /** The same question as data — hand it to `mesh.liveQuery` (or E10's `useLiveQuery`); nothing runs here. */
  readonly query: (options?: ListOptions<T>) => QueryDescriptor<T>;
  /** The row's writes oldest-first by stamp. A detail-view read: it scans the log. */
  readonly history: (key: KeyOf<T>) => Promise<Result<readonly Revision<T>[], HistoryError>>;
}

/** One recorded write of a `tx`: the change and the procedure label it contributes. */
export interface Write {
  readonly label: string;
  readonly apply: (tx: Tx) => void;
}

export interface CollectionDeps {
  readonly engine: Engine;
  readonly placement: () => Result<Placement, WriteError>;
  /** The schema's rule for the principal this collection speaks for. */
  readonly can: (what: `${string}.${string}`, row?: WireCells, patch?: WireCells) => boolean;
  /**
   * Enforce `can` here, not only at the validator: rows its `read` denies are invisible, and a
   * write it denies is `PolicyDenied` before any event. On for a view acting as someone other
   * than the device — the event is still the device's, so the validator alone would ask the
   * wrong principal.
   */
  readonly gated: boolean;
  /** The whole log, both scopes; `history` folds the slice that touches its row. */
  readonly log: () => Promise<Result<readonly StoredEvent[], StoreFailure>>;
  readonly merge: MergeSpec;
  readonly accountOf: (peer: PeerId) => string | undefined;
  /** Set for a `mesh.scoped` view: rides on every descriptor `query` makes, so results never share across scopes. */
  readonly scope?: string;
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- keys are opaque strings in the kernel; procedures are `table.op` labels (E09) */
const rowKey = (key: string): RowKey => key as RowKey;
const procedure = (label: string): Procedure => label as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const sameCell = (a: CellValue | undefined, b: CellValue | undefined): boolean =>
  a instanceof Uint8Array || b instanceof Uint8Array
    ? a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b)
    : JSON.stringify(a) === JSON.stringify(b);

/** The cells of `patch` whose value differs from `current`. */
const changed = (current: WireCells, patch: WireCells): WireCells =>
  new Map([...patch].filter(([column, value]) => !sameCell(current.get(column), value)));

export function createCollection<T extends Table>(
  table: T,
  deps: CollectionDeps,
): Collection<T> & { readonly writes: Writes<T>; readonly visible: Visible } {
  const { engine, placement, can, gated, log, merge, accountOf, scope } = deps;
  const name = table.name;
  const keyOf = (key: KeyOf<T>) => rowKey(String(key));

  const held = (key: RowKey): WireCells | undefined => visible().get(key);
  const visible = (): ReadonlyMap<RowKey, WireCells> => {
    const where = placement();
    if (where.isErr()) return new Map();
    const rows =
      where.value.partition === undefined
        ? readRows(engine.state(), table.name)
        : readRowsIn(engine.state(), table.name, where.value.partition);
    if (!gated) return rows;
    return new Map([...rows].filter(([, cells]) => can(`${name}.read`, cells)));
  };

  /** The gate's verdict as the validator would phrase it, so a denial reads the same either way. */
  const denied = (op: Operation, key: RowKey, row?: WireCells, patch?: WireCells) =>
    gated && !can(`${name}.${op}`, row, patch)
      ? Result.err(
          new PolicyDenied({
            table: String(name),
            key: String(key),
            op,
            message: `${op} on ${String(name)} denied`,
          }),
        )
      : Result.ok(undefined);

  const commit = (label: string, apply: (tx: Tx) => void, key: RowKey) =>
    Result.gen(async function* () {
      const where = yield* placement();
      yield* Result.await(engine.mutate(procedure(label), apply, where));
      const cells = held(key);
      return Result.ok(cells === undefined ? undefined : fromWireRow(table, cells));
    });

  const insertWrite = (row: InsertRow<T>): Result<Write & { key: RowKey }, WriteError> => {
    // SAFETY: InsertRow<T> is Row<T> with optional columns; toWireRow reads only the columns present
    const cells = withNulls(table, toWireRow(table, row as Partial<Row<T>>));
    const wireRow = Object.fromEntries(cells);
    const checked = checkRow(table, wireRow, "insert");
    if (checked.isErr()) return checked;
    const keyed = rowKeyText(table, wireRow);
    if (keyed.isErr()) return keyed;
    const key = rowKey(keyed.value);
    const verdict = denied("insert", key, undefined, cells);
    if (verdict.isErr()) return verdict;
    return Result.ok({
      key,
      label: `${name}.insert`,
      apply: (tx) => tx.insert(table.name, key, cells),
    });
  };

  /** The updater's edits as a whole row: it runs on a deep copy, so state is never mutated through it. */
  const edited = (current: WireCells, fn: (draft: Draft<T>) => void): Partial<Row<T>> => {
    const cloned = new Map([...current].map(([column, value]) => [column, structuredClone(value)]));
    // SAFETY: Draft<T> is Row<T> with its readonly lifted; the copy is the updater's to mutate
    const draft = fromWireRow(table, cloned) as Draft<T>;
    fn(draft);
    return draft;
  };

  const updateWrite = (key: KeyOf<T>, change: Update<T>): Result<Write, WriteError> => {
    const k = keyOf(key);
    const current = held(k);
    if (current === undefined) return Result.err(missing(name, k));
    const patch = change instanceof Function ? edited(current, change) : change;
    const cells = changed(current, toWireRow(table, patch));
    const checked = checkRow(table, Object.fromEntries(cells), "update");
    if (checked.isErr()) return checked;
    if (cells.size === 0) {
      return Result.err(
        new EmptyMutation({ procedure: procedure(`${name}.update`), message: "no column changed" }),
      );
    }
    const verdict = denied("update", k, current, cells);
    if (verdict.isErr()) return verdict;
    return Result.ok({ label: `${name}.update`, apply: (tx) => tx.update(table.name, k, cells) });
  };

  const deleteWrite = (key: KeyOf<T>): Result<Write, WriteError> => {
    const k = keyOf(key);
    const current = held(k);
    if (current === undefined) return Result.err(missing(name, k));
    const verdict = denied("delete", k, current);
    if (verdict.isErr()) return verdict;
    return Result.ok({ label: `${name}.delete`, apply: (tx) => tx.delete(table.name, k) });
  };

  const collection: Collection<T> & { readonly writes: Writes<T>; readonly visible: Visible } = {
    create: (row) =>
      Result.gen(async function* () {
        const write = yield* insertWrite(row);
        const stored = yield* Result.await(commit(write.label, write.apply, write.key));
        return stored === undefined ? Result.err(missing(name, write.key)) : Result.ok(stored);
      }),
    update: (key, patch) =>
      Result.gen(async function* () {
        const write = yield* updateWrite(key, patch);
        const stored = yield* Result.await(commit(write.label, write.apply, keyOf(key)));
        return stored === undefined ? Result.err(missing(name, keyOf(key))) : Result.ok(stored);
      }),
    delete: (key) =>
      Result.gen(async function* () {
        const write = yield* deleteWrite(key);
        yield* Result.await(commit(write.label, write.apply, keyOf(key)));
        return Result.ok(undefined);
      }),
    get: (key) => {
      const cells = held(keyOf(key));
      return cells === undefined ? undefined : fromWireRow(table, cells);
    },
    list: (options) => {
      const spec = specOf(options ?? {});
      const rows = [...visible()]
        .map(([key, cells]) => ({ key: String(key), row: fromWireRow(table, cells) }))
        .filter((entry) => matches(spec.where, entry.row))
        .sort((a, b) => compareRows(spec.orderBy, a, b))
        .map((entry) => entry.row);
      return options?.limit === undefined ? rows : rows.slice(0, options.limit);
    },
    can: (op, row) => can(`${name}.${op}`, row === undefined ? undefined : toWireRow(table, row)),
    query: (options) =>
      scope === undefined
        ? { table, options: options ?? {} }
        : { table, options: options ?? {}, scope },
    history: (key) =>
      Result.gen(async function* () {
        const where = yield* placement();
        const entries = yield* Result.await(log());
        return Result.ok(
          rowHistory(table, keyOf(key), entries, {
            merge,
            partition: where.partition,
            accountOf,
          }),
        );
      }),
    writes: { create: insertWrite, update: updateWrite, delete: deleteWrite },
    visible,
  };
  return collection;
}

/** The recording half of a collection, used by `tx`. Method syntax on purpose: `tx` relates these across tables. */
export interface Writes<T extends Table> {
  create(row: InsertRow<T>): Result<Write, WriteError>;
  update(key: KeyOf<T>, change: Update<T>): Result<Write, WriteError>;
  delete(key: KeyOf<T>): Result<Write, WriteError>;
}

const missing = (table: string, key: RowKey) =>
  new NoSuchRow({ table, key: String(key), message: `${table} has no row ${String(key)}` });
