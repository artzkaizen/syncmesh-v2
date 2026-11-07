import type { Row, RowKey, TableName } from "@syncmesh/kernel";
import type { CborValue } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import {
  decodeCbor,
  encodeCbor,
  isSafeNonNegative,
  isString,
  rowFromCbor,
  rowToCbor,
} from "@syncmesh/wire";

/**
 * The window frames' tags in the relay's control space (D14). They sit well above the tags
 * 8–19 the relay already uses, so a build that does not know them reads `unknown` and ignores
 * them (D39).
 */
export const WINDOW_TAGS = { desire: 32, undesire: 33, rows: 34 } as const;

export class MalformedWindowFrame extends TaggedError("MalformedWindowFrame")<{
  message: string;
}> {}

const malformed = (message: string) => Result.err(new MalformedWindowFrame({ message }));

/** Where a view's patch stream stands: patches are numbered `1, 2, …` within one epoch. */
export interface StreamPosition {
  readonly epoch: string;
  readonly version: number;
}

/** One row as the thin client holds it. */
export interface WindowRow {
  readonly key: RowKey;
  readonly row: Row;
}

/** A row the view now holds at this value, whether it is new or changed. */
export interface RowPut extends WindowRow {
  readonly table: TableName;
}

/** A row no window on this socket holds any more. */
export interface RowRef {
  readonly table: TableName;
  readonly key: RowKey;
}

/** A window's contents, in its order: at most `limit` keys into the rows the view holds. */
export interface WindowKeys {
  readonly id: string;
  readonly table: TableName;
  readonly keys: readonly RowKey[];
}

/** A window the server would not open, and why. */
export interface WindowRefusal {
  readonly id: string;
  readonly reason: string;
}

/**
 * One versioned patch to a socket's view (E24). `version` is exactly one more than the last
 * patch in the same `epoch`. A `reset` patch opens a new epoch at version 1 and carries the
 * whole view: everything the client held before it is gone.
 */
export interface RowPatch extends StreamPosition {
  readonly reset: boolean;
  readonly puts: readonly RowPut[];
  readonly dels: readonly RowRef[];
  /** Windows whose key list changed; a window not named here is unchanged. */
  readonly windows: readonly WindowKeys[];
  readonly refused: readonly WindowRefusal[];
}

/**
 * Asks for a window, or replaces the one already held under `id` (a scroll). With `since`, the
 * client also says where its stream stands; a server whose stream is anywhere else answers with
 * a reset.
 */
export interface Desire {
  readonly kind: "desire";
  readonly id: string;
  /** The query as wire text (`queryText`), parsed by whoever serves the window. */
  readonly query: string;
  readonly since?: StreamPosition;
}

export interface Undesire {
  readonly kind: "undesire";
  readonly id: string;
}

export type WindowFrame = Desire | Undesire | ({ readonly kind: "rows" } & RowPatch);

export const desireFrame = (id: string, query: string, since?: StreamPosition): Uint8Array =>
  encodeCbor(
    since === undefined
      ? [WINDOW_TAGS.desire, id, query]
      : [WINDOW_TAGS.desire, id, query, [since.epoch, since.version]],
  );

export const undesireFrame = (id: string): Uint8Array => encodeCbor([WINDOW_TAGS.undesire, id]);

export const rowsFrame = (patch: RowPatch): Uint8Array =>
  encodeCbor([
    WINDOW_TAGS.rows,
    patch.epoch,
    patch.version,
    patch.reset ? 1 : 0,
    patch.puts.map((put): CborValue => [put.table, put.key, rowToCbor(put.row)]),
    patch.dels.map((del): CborValue => [del.table, del.key]),
    patch.windows.map((w): CborValue => [w.id, w.table, [...w.keys]]),
    patch.refused.map((r): CborValue => [r.id, r.reason]),
  ]);

const parseList = <T>(
  value: CborValue | undefined,
  what: string,
  item: (entry: readonly CborValue[]) => Result<T, MalformedWindowFrame>,
): Result<readonly T[], MalformedWindowFrame> => {
  if (!Array.isArray(value)) return malformed(`${what} is not a list`);
  const out: T[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry)) return malformed(`${what} entry is not a list`);
    const decoded = item(entry);
    if (decoded.isErr()) return decoded;
    out.push(decoded.value);
  }
  return Result.ok(out);
};

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- table names and row keys are text the schema owns; the codec only requires text */
const asKey = (key: string) => key as RowKey;

const asRef = ([table, key]: readonly CborValue[]): Result<RowRef, MalformedWindowFrame> =>
  isString(table) && isString(key)
    ? Result.ok({ table: table as TableName, key: key as RowKey })
    : malformed("a row is named by [table, key]");

const asPut = (entry: readonly CborValue[]): Result<RowPut, MalformedWindowFrame> =>
  Result.gen(function* () {
    const ref = yield* asRef(entry);
    const row = yield* rowFromCbor(entry[2]).mapError(
      (e) => new MalformedWindowFrame({ message: e.message }),
    );
    return Result.ok({ ...ref, row });
  });

const asWindow = ([id, table, keys]: readonly CborValue[]): Result<
  WindowKeys,
  MalformedWindowFrame
> =>
  isString(id) && isString(table) && Array.isArray(keys) && keys.every((k) => isString(k))
    ? Result.ok({ id, table: table as TableName, keys: keys.filter(isString).map(asKey) })
    : malformed("a window is [id, table, keys]");
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const asRefusal = ([id, reason]: readonly CborValue[]): Result<
  WindowRefusal,
  MalformedWindowFrame
> =>
  isString(id) && isString(reason)
    ? Result.ok({ id, reason })
    : malformed("a refusal is [id, reason]");

const decodeRows = (parts: readonly CborValue[]): Result<WindowFrame, MalformedWindowFrame> =>
  Result.gen(function* () {
    const [, epoch, version, reset, puts, dels, windows, refused] = parts;
    if (!isString(epoch) || !isSafeNonNegative(version) || (reset !== 0 && reset !== 1))
      return malformed("rows is not [epoch, version, reset, …]");
    return Result.ok({
      kind: "rows",
      epoch,
      version,
      reset: reset === 1,
      puts: yield* parseList(puts, "puts", asPut),
      dels: yield* parseList(dels, "dels", asRef),
      windows: yield* parseList(windows, "windows", asWindow),
      refused: yield* parseList(refused, "refused", asRefusal),
    } as const);
  });

const decodeDesire = ([, id, query, since]: readonly CborValue[]): Result<
  WindowFrame,
  MalformedWindowFrame
> => {
  if (!isString(id) || !isString(query)) return malformed("desire is not [id, query]");
  if (since === undefined) return Result.ok({ kind: "desire", id, query });
  if (!Array.isArray(since) || !isString(since[0]) || !isSafeNonNegative(since[1]))
    return malformed("desire's since is not [epoch, version]");
  return Result.ok({ kind: "desire", id, query, since: { epoch: since[0], version: since[1] } });
};

/**
 * A window frame, or `undefined` for bytes that are some other frame on the same socket: a
 * window frame shares the link with the relay's own frames and is read only when its tag is one
 * of {@link WINDOW_TAGS}.
 */
export function decodeWindowFrame(
  bytes: Uint8Array,
): Result<WindowFrame | undefined, MalformedWindowFrame> {
  const outer = decodeCbor(bytes);
  if (outer.isErr() || !Array.isArray(outer.value)) return Result.ok(undefined);
  const parts: readonly CborValue[] = outer.value;
  const [tag, id] = parts;
  if (tag === WINDOW_TAGS.rows) return decodeRows(parts);
  if (tag === WINDOW_TAGS.desire) return decodeDesire(parts);
  if (tag === WINDOW_TAGS.undesire)
    return isString(id) ? Result.ok({ kind: "undesire", id }) : malformed("undesire is not [id]");
  return Result.ok(undefined);
}
