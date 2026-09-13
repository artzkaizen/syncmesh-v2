import type { PgDialect, PgTable, SubqueryWithSelection } from "drizzle-orm/pg-core";
import type { RemoteCallback } from "drizzle-orm/pg-proxy";

import { principalSettings } from "@syncmesh/storage";
import { getTableName } from "drizzle-orm";
import { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { PgProxyTransaction, PgRemoteSession } from "drizzle-orm/pg-proxy/session";

import type { FaceDeps, Span } from "./face.js";

import { commitHub } from "./face.js";
import { createLive } from "./live.js";
import { createProxy } from "./proxy.js";
import { readPredicate, readScope } from "./read.js";

export type PostgresMeshDb = PgRemoteDatabase<Record<string, never>>;

/** `read(table)`: the table's columns behind an alias, as pg-core's own `.as()` would type it. */
type Source<T extends PgTable> = SubqueryWithSelection<T["_"]["columns"], string>;

type Body<T> = (tx: PgProxyTransaction<Record<string, never>, Record<string, never>>) => Promise<T>;

/**
 * Drizzle's `pg-proxy` refuses `db.transaction()`; the mesh needs it as the capture boundary. This
 * session does what `sqlite-proxy`'s does — `begin`, the body, then `commit` or `rollback`, all
 * through the callback — so the proxy on the other side sees the same three control statements
 * on either dialect.
 */
class CapturingSession extends PgRemoteSession<Record<string, never>, Record<string, never>> {
  constructor(
    private readonly callback: RemoteCallback,
    private readonly pgDialect: PgDialect,
  ) {
    super(callback, pgDialect, undefined);
  }
  override async transaction<T>(body: Body<T>): Promise<T> {
    await this.callback("begin", [], "execute");
    try {
      const result = await body(new PgProxyTransaction(this.pgDialect, this, undefined, 0));
      await this.callback("commit", [], "execute");
      return result;
    } catch (cause) {
      await this.callback("rollback", [], "execute");
      throw cause;
    }
  }
}

/** The Postgres face: Drizzle's `pg-proxy` over the mesh's driver, so the app's statements run on the capturing connection. */
export function postgresFace(deps: FaceDeps) {
  const { engine, partition, actor, driver, writer, pgDialect } = deps;
  const hub = commitHub();
  const proxyDeps = { driver, writer, onCommit: hub.emit };
  if (partition !== undefined) Object.assign(proxyDeps, { partition });
  if (actor !== undefined || partition !== undefined) {
    // the caller's principal and pin land as transaction-local settings: what RLS policies read.
    // Without installRls they are inert; with it, a plain db.select() is already the caller's view.
    const settings = principalSettings(actor, partition === undefined ? {} : { partition });
    Object.assign(proxyDeps, {
      prelude: async () => {
        for (const { sql, params } of settings) await driver.run(sql, params);
      },
    });
  }
  const { callback, scope: mintSink, rehearse: rehearseOn, under } = createProxy(proxyDeps);
  const remote: RemoteCallback = (statement, params, method) => callback(statement, params, method);
  const dialect = pgDialect();
  const over = (sink: RemoteCallback): PostgresMeshDb =>
    new PgRemoteDatabase(dialect, new CapturingSession(sink, dialect), undefined);
  const db = over(remote);

  const newSpan = (): Span<PostgresMeshDb> => {
    const sql = mintSink();
    return { sql, db: over((statement, params, method) => sql(statement, params, method)) };
  };

  /**
   * `db.transaction()` on this handle is a scope, not a bare `BEGIN` on the shared sink: the `tx`
   * the body is handed writes through a sink nobody else has, so a read fired at the handle
   * meanwhile waits for the connection instead of landing inside the transaction and coming back
   * with a row nobody has committed. A body that ignores `tx` and reaches for `db` is the task
   * running beside its own transaction, and will wait for itself.
   */
  const transaction: PostgresMeshDb["transaction"] = (body, config) =>
    newSpan().db.transaction(body, config);
  Object.assign(db, { transaction });

  const scope = readScope("postgres", deps);
  /** The table as this principal may read it: a subquery with the `read` rule (and the pin) compiled in. */
  const read = <T extends PgTable>(table: T): Source<T> => {
    const name = getTableName(table);
    // SAFETY: pg-core's `from` refuses only a returning-less write subquery, a shape a table can never have; its guard is a conditional type that does not reduce on a type parameter, so the table goes in as its base class
    const source = table as PgTable;
    const aliased = db.select().from(source).where(readPredicate(name, scope)).as(name);
    // SAFETY: the alias wraps exactly the table's columns — what `.as()` would have typed had `from` taken T
    return aliased as Source<T>;
  };
  return {
    db,
    /**
     * A write scope of this handle's own: the {@link Span} a caller opens a transaction on when
     * the body doing the writing is somewhere else — a procedure handler given a mesh to write
     * through. `db.transaction()` mints one of these for itself; this is the same thing, handed
     * over rather than kept.
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
    rehearse: (open: (span: Span<PostgresMeshDb>) => Promise<void>) => {
      const scope = newSpan();
      return rehearseOn(scope.sql, () => open(scope));
    },
  };
}
