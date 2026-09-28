/**
 * Opening one database, in whichever VFS this thread can actually have.
 *
 * Split from `./vfs.ts`, which decides *which* VFS is available and holds the access-handle pool's
 * lease; this is what happens once that is settled. Every database here is a **pair** (RFC-0022):
 * the derived half is `main` and the durable log is a second file attached as `syncmesh`.
 */

import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { Result } from "@syncmesh/result";
import { ATTACHED_LOG, statePathFor } from "@syncmesh/storage";

import type {
  HeldPool,
  OpenedDatabase,
  OptionalVfs,
  PoolFailure,
  VfsOptions,
  WasmStorage,
} from "./vfs.js";

import { OpfsUnavailable, dropLease, holdPool } from "./vfs.js";

const fileOf = (name: string) => `${encodeURIComponent(name)}.db`;

/**
 * Attaches this database's log beside it, under the name its tables are written against.
 *
 * **Every database here is a pair** (RFC-0022): the durable log is the file the store is named
 * after, and the derived half — the app's own tables and the projection — hangs off it under a
 * name carrying the app's schema, and is what gets opened as `main`. The adapter does it rather
 * than the caller because the adapter is what knows the VFS, and on OPFS the VFS has to be named
 * in the URI or the attached file opens on the build's default one, which is not persistent.
 * That failure has no symptom until a reload.
 */
const attached = (db: Database, path: string, vfs: WasmStorage): Database => {
  db.exec(`ATTACH DATABASE 'file:${path}?vfs=${vfs}' AS ${ATTACHED_LOG}`);
  return db;
};

/**
 * One idle connection per memory database, never closed.
 *
 * `memdb` frees a database when its last connection goes, and `:memory:` does not even get that
 * far — it is private to one connection. Both would make a close-and-reopen of the same name lose
 * everything, which is not what "memory" is promising: it promises the life of the thread, and a
 * store closed and reopened between two screens is the same thread. This is what holds the pages
 * for that long, and no longer.
 */
const keepers = new Map<string, Database>();

/**
 * The durability settings, on a database that has just been opened and has done nothing else.
 *
 * **The same three every other adapter sets** — Bun, Node and Expo all write `WAL` and
 * `synchronous = NORMAL` (RFC-0004) — because a store that is durable differently per runtime is
 * a store whose failure modes are only ever exercised on one of them. The browser was the
 * exception and this removes it.
 *
 * `locking_mode = exclusive` is what makes WAL possible here at all, and its position is not
 * negotiable. The WASM build has no shared-memory APIs, so it cannot keep the WAL index that
 * coordinates connections; exclusive locking removes the need for one, and SQLite requires it be
 * set **immediately after opening, before anything else touches the handle** (supported since
 * 3.47; this package is on 3.53). Unprefixed, it also covers databases attached later.
 *
 * It costs nothing that is used. One writer per origin is already this adapter's shape twice
 * over: `opfs-sahpool` takes exclusive access handles for a whole directory, and the mesh elects
 * a single worker to hold the engine — a second tab is refused by the VFS before any of this is
 * reached, which is what {@link OpfsPoolHeld} exists to say.
 *
 * Memory databases are left alone: there is no file, so there is nothing to journal.
 */
const durably = (db: Database, storage: WasmStorage): Database => {
  if (storage === "memory") return db;
  // a refusal undoes the exclusive locking that was only ever asked for to make WAL possible:
  // paying for a lock and not getting the journal is the one outcome with no argument for it
  if (!walTaken(db)) db.exec("PRAGMA locking_mode = normal");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
};

/**
 * Asks for WAL, and answers whether it was given.
 *
 * **A VFS can decline in two ways and only one of them is quiet.** `PRAGMA journal_mode` normally
 * answers with the mode in effect rather than failing, so a build that will not take WAL leaves
 * the database in `delete` and says so in a row nobody reads — which is why the mode is read back
 * rather than assumed. But the switch also *writes*: WAL needs a `-wal` file, and on the
 * access-handle pool a file is a slot. A pool with no slot free, or any I/O error underneath,
 * raises rather than answers.
 *
 * Unhandled, that throw killed the open — and with it the app, over a journal. **A database
 * without WAL is a working database; a database that will not open is not.** So both refusals
 * land in the same place, and the caller learns the same thing from each: no.
 */
const walTaken = (db: Database): boolean =>
  Result.try({
    try: () => {
      db.exec("PRAGMA locking_mode = exclusive");
      db.exec("PRAGMA journal_mode = WAL");
      const answered = db.exec({
        sql: "PRAGMA journal_mode",
        rowMode: "array",
        returnValue: "resultRows",
      });
      // one row, one cell, and SQLite writes the mode in lower case — so anything that is not the
      // string `wal` is this build declining, whatever else it turns out to be
      const [mode] = answered[0] ?? [];
      return mode === "wal";
    },
    catch: (cause) => cause,
  }).unwrapOr(false);

export const memoryDatabase = (sqlite3: Sqlite3Static, options: VfsOptions): OpenedDatabase => {
  const log = `/${fileOf(options.name)}`;
  const logUri = `file:${log}?vfs=memdb`;
  // the derived half is a second memory database, kept open for the same reason the log is
  const stateUri = `file:${statePathFor(log, options.schema)}?vfs=memdb`;
  for (const held of [stateUri, logUri])
    if (!keepers.has(held)) keepers.set(held, new sqlite3.oo1.DB(held, "c"));
  const db = new sqlite3.oo1.DB(stateUri, "c");
  db.exec(`ATTACH DATABASE '${logUri}' AS ${ATTACHED_LOG}`);
  return { db, storage: "memory", release: () => {} };
};

/**
 * Closing twice is not an error anywhere else in the port, and must not double-drop the pool here.
 *
 * At zero the access handles and the lease go back together, in that order. They are the same
 * claim said twice — one to SQLite, one to every other tab — and a lease outliving the handles
 * would lock out a context that could have had them.
 */
function releaseOnce(pool: HeldPool, directory: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pool.open -= 1;
    if (pool.open > 0) return;
    pool.util.pauseVfs();
    dropLease(directory);
  };
}

/**
 * What the pool cannot promise past the point it hands the slots over: that SQLite will take them.
 *
 * Opening the pair is four calls that can each throw — the database, `locking_mode`,
 * `journal_mode`, the `ATTACH` — and `Result.map` turns a throw into a `Panic`, which is neither
 * catchable by the caller nor legible when it arrives across a port. So the work happens under
 * `Result.try`, the same way {@link opfsDatabaseIn} below has always done it.
 *
 * **And the pool goes back.** A throw here used to leave the slots taken and the lease held for
 * the life of the worker, so the second attempt met `OpfsPoolHeld` from the first one's corpse and
 * the origin reported another tab that did not exist.
 */
export const sahPoolDatabase = async (
  install: NonNullable<OptionalVfs["installOpfsSAHPoolVfs"]>,
  options: VfsOptions,
): Promise<Result<OpenedDatabase, PoolFailure>> => {
  const directory = `${options.directory}/pool`;
  const held = await holdPool(install, directory, options);
  if (held.isErr()) return held;
  const pool = held.value;
  const log = `/${fileOf(options.name)}`;
  const release = releaseOnce(pool, directory);
  const opened = Result.try({
    try: () => ({
      db: attached(
        durably(new pool.util.OpfsSAHPoolDb(statePathFor(log, options.schema)), "opfs-sahpool"),
        log,
        "opfs-sahpool",
      ),
      storage: "opfs-sahpool" as const,
      release,
    }),
    catch: (cause) =>
      new OpfsUnavailable({
        requested: "opfs-sahpool",
        message: "the access-handle pool installed, and SQLite would not open a database on it",
        cause,
      }),
  });
  if (opened.isErr()) release();
  return opened;
};

export const opfsDatabaseIn = (
  OpfsDb: NonNullable<OptionalVfs["oo1"]["OpfsDb"]>,
  options: VfsOptions,
): Result<OpenedDatabase, OpfsUnavailable> => {
  const log = `${options.directory}/db/${fileOf(options.name)}`;
  return Result.try({
    try: () => ({
      db: attached(
        durably(new OpfsDb(statePathFor(log, options.schema), "c"), "opfs"),
        log,
        "opfs",
      ),
      storage: "opfs" as const,
      release: () => {},
    }),
    catch: (cause) =>
      new OpfsUnavailable({
        requested: "opfs",
        message: "the OPFS VFS is installed, and SQLite would not open a database on it",
        cause,
      }),
  });
};
