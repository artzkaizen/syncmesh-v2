/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- this file *is* the thread boundary: a `postMessage` hands over `unknown`, the `kind` is the parse, and a serialized tagged error has no shape until the class that declared it revives (`@syncmesh/result`'s wire.ts disables the same two for the same reason) */

import type { BoundSqlValue, SqlRow } from "@syncmesh/storage";

import { TaggedError, createTaggedCatalog } from "@syncmesh/result";

import type { WasmStorage, WhenPoolHeld } from "./vfs.js";

import { SqliteWasmUnavailable } from "./module.js";
import { OpfsPoolHeld, OpfsUnavailable } from "./vfs.js";

/**
 * The half of `Worker`, `MessagePort` and a dedicated worker's own global scope that this protocol
 * uses, which is two members. Naming it rather than naming one of the three is what lets the same
 * host serve a worker in a browser and a `MessageChannel` in a test runner, and is why the
 * conformance suite can certify the wire without a browser.
 */
export interface WirePort {
  readonly postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** Opens a database on the host's thread; the reply says which VFS it landed on. */
export interface OpenCall {
  readonly kind: "open";
  readonly name: string;
  /** Names the derived half; the log keeps `name` (RFC-0022). See `VfsOptions.schema`. */
  readonly schema: string;
  readonly storage: WasmStorage | "auto";
  readonly directory: string;
  readonly capacity: number;
  /** What to do when another context holds the pool; absent reads as `"refuse"`, as it does here. */
  readonly whenHeld?: WhenPoolHeld;
}

/** One of {@link SqliteBinding}'s three statement calls, against a database the host holds open. */
export interface StatementCall {
  readonly kind: "exec" | "run" | "all";
  readonly db: number;
  readonly sql: string;
  readonly params: readonly BoundSqlValue[];
}

export interface CloseCall {
  readonly kind: "close";
  readonly db: number;
}

export type Call = OpenCall | StatementCall | CloseCall;

/** What an `"open"` answers with: the handle every later call carries, and where the bytes went. */
export interface Opened {
  readonly db: number;
  readonly storage: WasmStorage;
}

/** `null` for the calls that answer with nothing, so a reply is never ambiguous about its shape. */
export type Answer = Opened | readonly SqlRow[] | null;

/**
 * A call and the number that pairs it with its reply.
 *
 * Every value that crosses is already structured-cloneable without help: `bindSqlite` has turned
 * booleans and dates into integers before a parameter gets here, and what comes back is SQLite's
 * own storage classes — string, number, bigint, `Uint8Array`, null.
 */
export type Request = { readonly id: number } & Call;

export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: Answer }
  | { readonly id: number; readonly ok: false; readonly error: Record<string, unknown> };

/**
 * A statement the host's SQLite refused: a syntax error, a constraint, a closed database.
 *
 * Thrown rather than returned, because that is what the port says a driver does — `sqliteDriver`
 * lets its binding throw and every store above catches it into a `StoreFailure`. What the tag adds
 * over the `Error` a local binding would have thrown is the statement, which the stack cannot
 * carry across a thread boundary.
 */
export class SqliteStatementFailed extends TaggedError("SqliteStatementFailed")<{
  readonly sql: string;
  message: string;
}> {}

/**
 * A database handle the host does not hold. Reached by using a driver after `close`, which is the
 * one way a correct page can produce it.
 */
export class NoSuchDatabase extends TaggedError("NoSuchDatabase")<{
  readonly db: number;
  message: string;
}> {}

/**
 * The failures that cross the port, revived on the page as the classes the page already declares —
 * so `matchError` and an `instanceof OpfsUnavailable` keep working after a thread hop (book ch. 5).
 */
export const failures = createTaggedCatalog([
  SqliteWasmUnavailable,
  OpfsUnavailable,
  OpfsPoolHeld,
  SqliteStatementFailed,
  NoSuchDatabase,
]);
