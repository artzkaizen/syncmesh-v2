import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { FaceDeps, Span } from "./face.js";

import { commitHub } from "./face.js";
import { createLive } from "./live.js";
import { createProxy } from "./proxy.js";
import { readPredicate, readScope } from "./read.js";

export type SqliteMeshDb = SqliteRemoteDatabase<Record<string, never>>;

/** The SQLite face: Drizzle's `sqlite-proxy` over the device's own connection. */
export function sqliteFace(deps: FaceDeps) {
  const { engine, partition, driver, writer } = deps;
  const hub = commitHub();
  const proxyDeps = { driver, writer, onCommit: hub.emit };
  if (partition !== undefined) Object.assign(proxyDeps, { partition });
  const { callback, scope: mintSink, rehearse: rehearseOn, under } = createProxy(proxyDeps);
  const db: SqliteMeshDb = drizzle((statement, params, method) =>
    callback(statement, params, method),
  );

  const newSpan = (): Span<SqliteMeshDb> => {
    const sql = mintSink();
    return { sql, db: drizzle((statement, params, method) => sql(statement, params, method)) };
  };

  /**
   * `db.transaction()` on this handle is a scope, not a bare `BEGIN` on the shared sink: the `tx`
   * the body is handed writes through a sink nobody else has, so a read fired at the handle
   * meanwhile waits for the connection instead of landing inside the transaction and coming back
   * with a row nobody has committed. A body that ignores `tx` and reaches for `db` is the task
   * running beside its own transaction, and will wait for itself.
   */
  const transaction: SqliteMeshDb["transaction"] = (body, config) =>
    newSpan().db.transaction(body, config);
  Object.assign(db, { transaction });

  const reading = readScope("sqlite", deps);
  /** The table as this principal may read it: a subquery with the `read` rule (and the pin) compiled in. */
  const read = <T extends SQLiteTable>(table: T) => {
    const name = getTableName(table);
    return db.select().from(table).where(readPredicate(name, reading)).as(name);
  };
  return {
    db,
    /**
     * The statement sink under `db`, for a transport that carries statements instead of issuing
     * them: a tab whose capture is on another thread posts `(statement, params, method)` across a
     * port, and the host feeds each one in here — so `db.transaction()` over there opens *this*
     * capture, and a write made in that tab is still one signed event of this device.
     *
     * Adapter surface, not app surface. An app has `db`, which is this with Drizzle on top; going
     * round Drizzle to reach it buys nothing but a chance to send SQL the builder would not have.
     *
     * This is the *shared* sink, and a transaction opened on it admits every other statement sent
     * to it — there is no author to tell them apart by. A host feeding one tab's statements should
     * hold a {@link Span} for the length of that tab's transaction and feed `span.sql` instead.
     */
    sql: callback,
    /**
     * A write scope of this handle's own: the {@link Span} a caller opens a transaction on when
     * the body doing the writing is somewhere else — a procedure handler given a mesh to write
     * through, or a tab whose statements arrive over a port. `db.transaction()` mints one of these
     * for itself; this is the same thing, handed over rather than kept.
     */
    span: newSpan,
    read,
    live: createLive(engine),
    onCommit: hub.onCommit,
    /** Runs a write under what the caller knows about it: its id, and the procedure it is. */
    under,
    /**
     * The write, rehearsed: statements run, the ladder judges, everything rolls back (ch. 15).
     *
     * The body reads and writes through the {@link Span} it is handed, exactly as it does on the
     * real write path, and **not** through the handle's `db`: the rehearsal is the one transaction
     * the handle is holding, and only the span's own sink is inside it. It must not open a
     * transaction of its own either, for the same reason.
     */
    rehearse: (open: (span: Span<SqliteMeshDb>) => Promise<void>) => {
      const scope = newSpan();
      return rehearseOn(scope.sql, () => open(scope));
    },
  };
}
