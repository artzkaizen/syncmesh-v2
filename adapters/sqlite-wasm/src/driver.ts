import type { SqliteDriver } from "@syncmesh/storage";

import { Result, TaggedError } from "@syncmesh/result";
import { sqliteDriver } from "@syncmesh/storage";

import type { SqliteWasmUnavailable } from "./module.js";
import type { WirePort } from "./protocol.js";
import type { PoolFailure, VfsOptions, WasmStorage, WhenPoolHeld } from "./vfs.js";

import { bindingFor } from "./binding.js";
import { loadSqlite } from "./module.js";
import { connectSqlite } from "./remote.js";
import { openDatabase, originHasOpfs, threadHasSyncAccessHandles } from "./vfs.js";

/** The pool holds a file open per slot, so the default is "three scoped stores and their journals". */
const CAPACITY = 8;

/** Everything of this origin's under one root, so a second library's OPFS files are never in reach. */
const DIRECTORY = "/syncmesh";

/**
 * The dedicated worker that would have held the durable database could not be started.
 *
 * Not a browser that lacks OPFS — that thread never gets here — but a `new Worker` the page was
 * refused: a Content-Security-Policy without `worker-src`, or a bundler that did not emit
 * `worker.js` beside the module that names it. Distinct from `SqliteWasmUnavailable`, where the
 * worker started and SQLite did not arrive in it.
 */
export class SqliteWorkerUnavailable extends TaggedError("SqliteWorkerUnavailable")<{
  cause?: unknown;
}> {}

export interface WasmSqliteOptions {
  /**
   * The database, as `storeNameFor` names one scope's (D07). Percent-encoded into a filename, so
   * a partition id with a slash or a colon in it is still one file and still injective.
   */
  readonly name: string;
  /**
   * Which VFS to open on; `"auto"` by default, which takes the best that is reachable from this
   * page — through a worker where that is what it takes — and only reports `OpfsUnavailable` when
   * a browser that has OPFS refuses to hand it over.
   */
  readonly storage?: WasmStorage | "auto";
  /** The OPFS root; change it only to run two independent meshes in one origin. */
  readonly directory?: string;
  /** Pool slots, when one tab holds more scopes open than the default covers. */
  readonly capacity?: number;
  /**
   * Where the worker comes from, for a bundler that will not follow
   * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, or for a page that
   * already has one and would rather hand over a `MessagePort` to it.
   *
   * `false` keeps the database on the calling thread, which in a window means `"memory"` — say it
   * when a memory database is what you actually want and a worker would be waste.
   *
   * A factory you supply is called once per `wasmSqliteDriver`. The packaged worker is not: it is
   * started at most once per page, because SQLite's access-handle pool is exclusive per origin
   * directory and two workers asking for it would be the second one failing.
   */
  readonly worker?: (() => WirePort) | false;
  /**
   * What to do when another browsing context of this origin holds the access-handle pool; see
   * {@link WhenPoolHeld}. Default `"refuse"`, which is the right answer for a tab asking whether
   * it may be durable — and the wrong one for a worker that has already won an election and is
   * entitled to the pool the moment the browser finishes reaping the context that had it.
   */
  readonly whenHeld?: WhenPoolHeld;
}

/**
 * A {@link SqliteDriver} that says where it put the bytes. `storage` is on the driver rather than
 * in a log line because `"memory"` is a different product: every write is gone at the next reload,
 * and an app that shows "saved" over it has told the user something untrue.
 */
export interface WasmSqliteDriver extends SqliteDriver {
  readonly storage: WasmStorage;
}

/**
 * Every way opening a browser database fails, and they are four different facts: SQLite did not
 * load, the worker would not start, the durable VFS is out of reach on this thread, or another
 * browsing context of this origin is holding it. Only the last one clears by itself.
 */
export type WasmSqliteFailure = SqliteWasmUnavailable | PoolFailure | SqliteWorkerUnavailable;

/**
 * One worker per page, whatever it opens.
 *
 * Not an optimisation. The access-handle pool takes exclusive handles for a whole directory, so a
 * second worker asking for the same one is a second worker being refused; and two WASM heaps
 * cannot see each other's databases, so two scoped stores (D07) in two workers could never share a
 * transaction. One thread, N databases, as it would be in a process.
 */
let packaged: Result<ReturnType<typeof connectSqlite>, SqliteWorkerUnavailable> | undefined;

const startWorker = (): WirePort =>
  new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

const hostFor = (factory: WasmSqliteOptions["worker"]) => {
  const start = Result.try({
    try: factory === undefined || factory === false ? startWorker : factory,
    catch: (cause) => new SqliteWorkerUnavailable({ cause }),
  });
  if (factory !== undefined) return start.map(connectSqlite);
  packaged ??= start.map(connectSqlite);
  return packaged;
};

const inThread = (storage: WasmStorage | "auto", where: VfsOptions) =>
  Result.gen(async function* () {
    const sqlite3 = yield* Result.await(loadSqlite());
    const opened = yield* Result.await(openDatabase(sqlite3, storage, where));
    return Result.ok({ ...sqliteDriver(bindingFor(opened)), storage: opened.storage });
  });

const inWorker = (
  factory: WasmSqliteOptions["worker"],
  storage: WasmStorage | "auto",
  where: VfsOptions,
) =>
  Result.gen(async function* () {
    const host = yield* hostFor(factory);
    return await host.open({ ...where, storage });
  });

/**
 * Whether this call has to cross a thread to be durable.
 *
 * Three facts decide it and none of them is a guess. This thread has no synchronous access
 * handles, so it cannot open a durable VFS itself; the origin *does* have OPFS, so a thread that
 * can exists here and this is a browser rather than a test runner; and the caller did not ask for
 * `"memory"`, which needs no file and no worker to be exactly what it promises.
 */
const needsWorker = (options: WasmSqliteOptions, storage: WasmStorage | "auto") =>
  storage !== "memory" &&
  options.worker !== false &&
  !threadHasSyncAccessHandles() &&
  originHasOpfs();

/**
 * Opens `name` as a driver for `@syncmesh/storage` on SQLite's official WASM build — the browser's
 * side of the port `node:sqlite` and `bun:sqlite` answer elsewhere (RFC-0004).
 *
 * **A durable database is in a worker, and from a window this call puts it there.** Both OPFS
 * VFSes are built on `FileSystemFileHandle.createSyncAccessHandle`, which the File System API
 * exposes only in a dedicated worker — so a database opened on a page's own thread can only be
 * `memory`, in every browser, cross-origin isolated or not. Called from a window with OPFS, this
 * starts `worker.js`, opens the database there, and returns a driver that reaches it over a
 * `MessagePort`. Called from inside a worker it opens in place. Nothing above the driver changes
 * either way: `SqlDriver`'s calls have always returned promises.
 *
 * **What the worker costs is a round trip per statement.** A `MessagePort` hop is a task, so a
 * transaction of a thousand statements is a thousand tasks — real, and still the only way a
 * browser is durable at all. `storage: "memory"` stays on the calling thread and pays none of it.
 *
 * **No WAL.** Both OPFS VFSes refuse it: WAL wants shared memory across connections, which is the
 * one thing a VFS built out of exclusive file handles cannot offer. The rollback journal is what
 * a browser gets, and the pool's capacity has to have room for it.
 *
 * **Close, and tabs.** `close` shuts the connection *and* gives back what the VFS was holding: on
 * `"opfs-sahpool"` the last driver to close returns the access handles for the whole directory, so
 * a tab that has closed its stores stops locking every other tab of the origin out. The open in
 * that other tab still has to be retried — nothing here polls on its behalf — and a tab that keeps
 * a store open keeps the pool. Two tabs that both want to write at once want `"opfs"`, which needs
 * the same worker *and* COOP/COEP headers, or one leader elected over `navigator.locks`.
 *
 * **Under Vite**, `optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] }` — pre-bundling rewrites
 * the URL `sqlite3.wasm` is fetched relative to, and it applies to the worker exactly as it does
 * to the page. That one line is the whole configuration: the worker and the `.wasm` are emitted by
 * the `new Worker(new URL(…))` above, and no COOP/COEP headers are needed for `"opfs-sahpool"`.
 *
 * @example
 * const driver = (await wasmSqliteDriver({ name: "user" })).unwrap();
 * if (driver.storage === "memory") warnTheUserNothingIsBeingSaved();
 * const stores = (await openStores(driver, { tables })).unwrap();
 */
export function wasmSqliteDriver(
  options: WasmSqliteOptions,
): Promise<Result<WasmSqliteDriver, WasmSqliteFailure>> {
  const storage = options.storage ?? "auto";
  const where = {
    name: options.name,
    directory: options.directory ?? DIRECTORY,
    capacity: options.capacity ?? CAPACITY,
    ...(options.whenHeld !== undefined && { whenHeld: options.whenHeld }),
  };
  return needsWorker(options, storage)
    ? inWorker(options.worker, storage, where)
    : inThread(storage, where);
}
