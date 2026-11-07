import type { CellValue, ColumnName, JsonValue, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { PolicyContext, PolicyNode } from "@syncmesh/policy";

import { NO_ROLES, evaluate, parsePolicyNode } from "@syncmesh/policy";
import { Result, TaggedError, omitUndefined } from "@syncmesh/result";

export type Direction = "asc" | "desc";

/** A scalar a window can order by. Bytes, arrays and objects have no order here. */
export type OrderCell = string | number | boolean | null;

/** The last row before a window: its order cells and its key, which breaks every tie. */
export interface KeysetBound {
  readonly cells: readonly OrderCell[];
  readonly key: RowKey;
}

/**
 * What a window asks for (D39): E13's predicate grammar, plus an order and a limit. It is not a
 * new language. The row key is always the final tiebreak, so the order is total and `after` is
 * a keyset bound. Moving a window costs the same at row ten million as at row ten.
 */
export interface WindowQuery {
  readonly table: TableName;
  /** The policy AST, evaluated as a read rule is. Absent, every row the reader may see. */
  readonly where?: PolicyNode;
  readonly order: readonly (readonly [ColumnName, Direction])[];
  readonly limit: number;
  /** Start strictly after this row; absent, at the top. */
  readonly after?: KeysetBound;
}

export class MalformedQuery extends TaggedError("MalformedQuery")<{ message: string }> {}

/** The largest window a query may ask for; a window is a screen, not an export. */
export const MAX_LIMIT = 1000;

const malformed = (message: string) => Result.err(new MalformedQuery({ message }));

/** A query as wire text: JSON, because it is a policy node and some scalars. */
export const queryText = (query: WindowQuery): string => JSON.stringify(query);

/* oxlint-disable anti-slop/no-runtime-typeof -- parsing wire text is the I/O boundary */
const isRecord = (v: JsonValue | undefined): v is { readonly [key: string]: JsonValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isOrderCell = (v: JsonValue): v is OrderCell => v === null || typeof v !== "object";
const isText = (v: JsonValue | undefined): v is string => typeof v === "string";
/* oxlint-enable anti-slop/no-runtime-typeof */

const parseOrder = (json: JsonValue | undefined): Result<WindowQuery["order"], MalformedQuery> => {
  if (!Array.isArray(json)) return malformed("order is not a list");
  const order: (readonly [ColumnName, Direction])[] = [];
  for (const term of json) {
    if (!Array.isArray(term) || !isText(term[0]) || (term[1] !== "asc" && term[1] !== "desc"))
      return malformed('an order term is [column, "asc" | "desc"]');
    // SAFETY: column names are the schema's; the source refuses one its table does not have
    order.push([term[0] as ColumnName, term[1]]);
  }
  return Result.ok(order);
};

const parseAfter = (
  json: JsonValue | undefined,
  width: number,
): Result<KeysetBound | undefined, MalformedQuery> => {
  if (json === undefined) return Result.ok(undefined);
  if (!isRecord(json) || !Array.isArray(json.cells) || !isText(json.key))
    return malformed("after is not { cells, key }");
  if (json.cells.length !== width || !json.cells.every(isOrderCell))
    return malformed("after needs one scalar per order term");
  // SAFETY: a row key is text the schema owns; the codec only requires text
  return Result.ok({ cells: json.cells, key: json.key as RowKey });
};

/**
 * Reads a query off the wire. Unlike an interest, a malformed query is refused rather than
 * widened: "everything" is never a sensible window, and the client is told why.
 */
export function parseQuery(text: string): Result<WindowQuery, MalformedQuery> {
  return Result.gen(function* () {
    const json = yield* Result.try({
      // SAFETY: JSON.parse returns JSON; every field is checked below before it is used
      try: () => JSON.parse(text) as JsonValue,
      catch: () => new MalformedQuery({ message: "query is not JSON" }),
    });
    if (!isRecord(json) || !isText(json.table)) return malformed("query needs a table");
    const limit = json.limit;
    if (!Number.isSafeInteger(limit) || !(Number(limit) > 0 && Number(limit) <= MAX_LIMIT))
      return malformed(`limit is a whole number from 1 to ${MAX_LIMIT}`);
    const order = yield* parseOrder(json.order);
    const after = yield* parseAfter(json.after, order.length);
    const where =
      json.where === undefined
        ? undefined
        : yield* parsePolicyNode(json.where).mapError(
            (e) => new MalformedQuery({ message: e.message }),
          );
    return Result.ok(
      omitUndefined({
        // SAFETY: table names are the schema's; the source refuses one it does not hold
        table: json.table as TableName,
        where,
        order,
        limit: Number(limit),
        after,
      }),
    );
  });
}

/* oxlint-disable anti-slop/no-runtime-typeof -- ordering dispatches on a scalar's runtime kind */
const rank = (v: OrderCell): number => {
  if (v === null) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  return 3;
};

/** A cell as the order reads it; bytes, arrays, objects and absent cells order as null. */
const orderCell = (v: CellValue | undefined): OrderCell =>
  v === undefined || (v !== null && typeof v === "object") ? null : v;
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * One total order over scalars: null, then booleans, then numbers, then strings by UTF-16 code
 * unit. A Postgres source must order the same way, which for text means `COLLATE "C"`.
 */
export function compareCells(a: OrderCell, b: OrderCell): number {
  const byKind = rank(a) - rank(b);
  if (byKind !== 0) return byKind;
  // SAFETY: same rank, so both are null, both booleans, both numbers or both strings
  const [x, y] = [a, b] as [string, string];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A row's position under an order: its order cells, then its key. */
export interface SortKey {
  readonly cells: readonly OrderCell[];
  readonly key: RowKey;
}

export const sortKey = (order: WindowQuery["order"], key: RowKey, row: Row): SortKey => ({
  cells: order.map(([column]) => orderCell(row.get(column))),
  key,
});

/** Compares two positions under `order`, the key breaking ties, so no two rows are equal. */
export function compareSortKeys(order: WindowQuery["order"], a: SortKey, b: SortKey): number {
  for (const [i, [, direction]] of order.entries()) {
    // SAFETY: both keys were built from this order, so each has one cell per term
    const byCell = compareCells(a.cells[i] as OrderCell, b.cells[i] as OrderCell);
    if (byCell !== 0) return direction === "asc" ? byCell : -byCell;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The reader a `where` is evaluated for: whoever holds the socket, as a read rule sees them. */
export type Reader = Pick<PolicyContext, "grant" | "roles">;

/** A reader with no account and no claims; `owner` and claim rules match nothing for it. */
export const ANONYMOUS: Reader = { grant: { account: "", claims: {} }, roles: NO_ROLES };

/** Whether a row is one this window's `where` admits, for this reader. */
export const matchesWhere = (query: WindowQuery, row: Row, reader: Reader = ANONYMOUS): boolean =>
  query.where === undefined || evaluate(query.where, { ...reader, row });
