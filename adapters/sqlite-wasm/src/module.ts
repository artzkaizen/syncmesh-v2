import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { Result, TaggedError } from "@syncmesh/result";

/**
 * SQLite never arrived: the `.wasm` payload did not load, or this environment refused to
 * instantiate it. Distinct from `OpfsUnavailable`, which is SQLite running fine with nowhere
 * durable to put a database — here there is nothing to run at all.
 *
 * In practice this is a build failure rather than a browser failure. The module fetches
 * `sqlite3.wasm` relative to its own URL, so a bundler that emits the JavaScript and leaves the
 * `.wasm` behind lands here, as does a dev server that answers the missing file with its index
 * page. Under Vite that means `optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] }` —
 * dependency pre-bundling rewrites the URL the fetch is relative to, and the file stops being
 * where the module looks for it.
 */
export class SqliteWasmUnavailable extends TaggedError("SqliteWasmUnavailable")<{
  cause?: unknown;
}> {}

let loaded: Promise<Result<Sqlite3Static, SqliteWasmUnavailable>> | undefined;

/**
 * SQLite's WASM build, instantiated once per thread and shared by every database opened on it.
 * The module owns a WASM heap, so a second instance is a second copy of SQLite in memory whose
 * databases the first one cannot see — sharing it is the only way two scoped stores (D07) can
 * live in one tab at all.
 *
 * A failed load is deliberately not remembered. The usual cause is a fetch, and a cached rejection
 * would outlive the tunnel that produced it; the next caller gets a fresh attempt instead.
 */
export function loadSqlite(): Promise<Result<Sqlite3Static, SqliteWasmUnavailable>> {
  loaded ??= Result.tryPromise({
    try: () => sqlite3InitModule(),
    catch: (cause) => new SqliteWasmUnavailable({ cause }),
  }).then((result) => {
    if (result.isErr()) loaded = undefined;
    return result;
  });
  return loaded;
}
