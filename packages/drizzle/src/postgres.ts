import type { EmptyRelations } from "drizzle-orm";
import type { PgDialect, PgTable, SubqueryWithSelection } from "drizzle-orm/pg-core";
import type { PgRemoteQueryResultHKT, RemoteCallback } from "drizzle-orm/pg-proxy";

import { principalSettings } from "@syncmesh/storage";
import { getTableName } from "drizzle-orm";
import { PgAsyncTransaction } from "drizzle-orm/pg-core";
import { PgRemoteDatabase, PgRemoteSession } from "drizzle-orm/pg-proxy";

import type { FaceDeps } from "./face.js";

import { commitHub } from "./face.js";
import { createLive } from "./live.js";
import { createProxy } from "./proxy.js";
import { readPredicate, readScope } from "./read.js";

export type PostgresMeshDb = PgRemoteDatabase<EmptyRelations>;

/** `read(table)`: the table's columns behind an alias, as pg-core's own `.as()` would type it. */
type Source<T extends PgTable> = SubqueryWithSelection<T["_"]["columns"], string>;

type Tx = PgAsyncTransaction<PgRemoteQueryResultHKT, EmptyRelations>;
type Body<T> = (tx: Tx) => Promise<T>;

/**
 * The transaction handed to `db.transaction()`'s body. Drizzle 1.0 no longer ships pg-proxy's own
 * transaction class, so the face declares it; a nested `tx.transaction()` is refused, as pg-proxy
 * refused it before — a savepoint would reach the capture as a plain statement.
 */
class CapturingTransaction extends PgAsyncTransaction<PgRemoteQueryResultHKT, EmptyRelations> {
  override transaction<T>(_body: Body<T>): Promise<T> {
    return Promise.reject(new Error("Transactions are not supported by the Postgres Proxy driver"));
  }
}

/**
 * Drizzle's `pg-proxy` refuses `db.transaction()`; the mesh needs it as the capture boundary. This
 * session does what `sqlite-proxy`'s does — `begin`, the body, then `commit` or `rollback`, all
 * through the callback — so the proxy on the other side sees the same three control statements
 * on either dialect.
 */
class CapturingSession extends PgRemoteSession<EmptyRelations> {
  constructor(
    private readonly callback: RemoteCallback,
    private readonly pgDialect: PgDialect,
  ) {
    super(callback, pgDialect, {});
  }
  override async transaction<T>(body: Body<T>): Promise<T> {
    await this.callback("begin", [], "execute");
    try {
      const result = await body(new CapturingTransaction(this.pgDialect, this, {}, 0, false));
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
  const { callback } = createProxy(proxyDeps);
  const remote: RemoteCallback = (statement, params, method) => callback(statement, params, method);
  const dialect = pgDialect();
  const db: PostgresMeshDb = new PgRemoteDatabase(
    dialect,
    new CapturingSession(remote, dialect),
    {},
  );
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
  return { db, read, live: createLive(engine), onCommit: hub.onCommit };
}
