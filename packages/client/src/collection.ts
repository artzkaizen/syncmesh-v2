import type { Engine, Tx } from "@syncmesh/engine";
import type { CellValue, Procedure, Row as WireCells, RowKey } from "@syncmesh/kernel";
import type { Operation } from "@syncmesh/policy";
import type { InsertRow, Row, Table } from "@syncmesh/schema";

import { EmptyMutation } from "@syncmesh/engine";
import { readRows, readRowsIn } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { checkRow, fromWireRow, toWireRow, withDefaults } from "@syncmesh/schema";
import { bytesEqual } from "@syncmesh/wire";

import type { Placement } from "./context.js";
import type { WriteError } from "./errors.js";
import type { OrderBy, Where } from "./query.js";
import type { QueryHandle, QueryRegistry } from "./registry.js";

import { NoSuchRow } from "./errors.js";

/** The value of the table's primary key column. */
export type KeyOf<T extends Table> = Row<T>[T["primaryKey"]];

export interface Collection<T extends Table> {
  /** One event in the table's instance; defaults and `null`s fill what the row omits. */
  readonly insert: (row: InsertRow<T>) => Promise<Result<Row<T>, WriteError>>;
  /** Writes only the columns whose value differs from the row held; nothing changed is `EmptyMutation`. */
  readonly update: (key: KeyOf<T>, patch: Partial<Row<T>>) => Promise<Result<Row<T>, WriteError>>;
  readonly delete: (key: KeyOf<T>) => Promise<Result<void, WriteError>>;
  readonly byId: (key: KeyOf<T>) => Row<T> | undefined;
  /** Every visible row in the active instance (or the whole table for global, user and local). */
  readonly all: () => readonly Row<T>[];
  readonly can: (op: Operation, row?: Row<T>) => boolean;
  /** A live filtered result; re-emits at most once per fold batch. Release it when done. */
  readonly where: (filter?: Where<T>, options?: ListOptions<T>) => QueryHandle<T>;
  /** The live table in order; `where` without a filter. */
  readonly list: (options?: ListOptions<T>) => QueryHandle<T>;
}

export interface ListOptions<T extends Table> {
  readonly orderBy?: OrderBy<T>;
}

interface SpecDraft<T extends Table> {
  where?: Where<T>;
  orderBy?: OrderBy<T>;
}

/** One recorded write of a `tx`: the change and the procedure label it contributes. */
export interface Write {
  readonly label: string;
  readonly apply: (tx: Tx) => void;
}

export interface CollectionDeps {
  readonly engine: Engine;
  readonly placement: () => Result<Placement, WriteError>;
  readonly can: (what: `${string}.${string}`, row?: WireCells) => boolean;
  readonly queries: QueryRegistry;
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
): Collection<T> & { readonly writes: Writes<T> } {
  const { engine, placement, can, queries } = deps;
  const name = String(table.name);
  const keyOf = (key: KeyOf<T>) => rowKey(String(key));

  const held = (key: RowKey): WireCells | undefined => visible().get(key);
  const visible = (): ReadonlyMap<RowKey, WireCells> => {
    const where = placement();
    if (where.isErr() || where.value.partition === undefined) {
      return where.isOk() ? readRows(engine.state(), table.name) : new Map();
    }
    return readRowsIn(engine.state(), table.name, where.value.partition);
  };

  const commit = (label: string, apply: (tx: Tx) => void, key: RowKey) =>
    Result.gen(async function* () {
      const where = yield* placement();
      yield* Result.await(engine.mutate(procedure(label), apply, where));
      const cells = held(key);
      return Result.ok(cells === undefined ? undefined : fromWireRow(table, cells));
    });

  const insertWrite = (row: InsertRow<T>): Result<Write & { key: RowKey }, WriteError> => {
    // SAFETY: InsertRow<T> is Row<T> with optional columns; toWireRow reads only the columns present
    const cells = withDefaults(table, toWireRow(table, row as Partial<Row<T>>));
    const checked = checkRow(table, Object.fromEntries(cells), "insert");
    if (checked.isErr()) return checked;
    const pk = table.columnNames[table.primaryKey];
    const pkValue = pk === undefined ? undefined : cells.get(pk);
    // SAFETY: the primary key column is text, integer or uuid, and checkRow above validated its value
    const key = rowKey(String(pkValue as string | number));
    return Result.ok({
      key,
      label: `${name}.insert`,
      apply: (tx) => tx.insert(table.name, key, cells),
    });
  };

  const updateWrite = (key: KeyOf<T>, patch: Partial<Row<T>>): Result<Write, WriteError> => {
    const k = keyOf(key);
    const current = held(k);
    if (current === undefined) return Result.err(missing(name, k));
    const cells = changed(current, toWireRow(table, patch));
    const checked = checkRow(table, Object.fromEntries(cells), "update");
    if (checked.isErr()) return checked;
    if (cells.size === 0) {
      return Result.err(
        new EmptyMutation({ procedure: procedure(`${name}.update`), message: "no column changed" }),
      );
    }
    return Result.ok({ label: `${name}.update`, apply: (tx) => tx.update(table.name, k, cells) });
  };

  const deleteWrite = (key: KeyOf<T>): Result<Write, WriteError> => {
    const k = keyOf(key);
    if (held(k) === undefined) return Result.err(missing(name, k));
    return Result.ok({ label: `${name}.delete`, apply: (tx) => tx.delete(table.name, k) });
  };

  const collection: Collection<T> & { readonly writes: Writes<T> } = {
    insert: (row) =>
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
    byId: (key) => {
      const cells = held(keyOf(key));
      return cells === undefined ? undefined : fromWireRow(table, cells);
    },
    all: () => [...visible().values()].map((cells) => fromWireRow(table, cells)),
    can: (op, row) => can(`${name}.${op}`, row === undefined ? undefined : toWireRow(table, row)),
    where: (filter, options) => {
      const spec: SpecDraft<T> = {};
      if (filter !== undefined) spec.where = filter;
      if (options?.orderBy !== undefined) spec.orderBy = options.orderBy;
      return queries.acquire(table, spec, visible);
    },
    list: (options) => collection.where(undefined, options),
    writes: { insert: insertWrite, update: updateWrite, delete: deleteWrite },
  };
  return collection;
}

/** The recording half of a collection, used by `tx`. Method syntax on purpose: `tx` relates these across tables. */
export interface Writes<T extends Table> {
  insert(row: InsertRow<T>): Result<Write, WriteError>;
  update(key: KeyOf<T>, patch: Partial<Row<T>>): Result<Write, WriteError>;
  delete(key: KeyOf<T>): Result<Write, WriteError>;
}

const missing = (table: string, key: RowKey) =>
  new NoSuchRow({ table, key: String(key), message: `${table} has no row ${String(key)}` });
