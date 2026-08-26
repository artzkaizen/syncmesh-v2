import type { PgDialect, PgTable, SubqueryWithSelection } from "drizzle-orm/pg-core";
import type { RemoteCallback } from "drizzle-orm/pg-proxy";

import { getTableName } from "drizzle-orm";
import { PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import { PgProxyTransaction, PgRemoteSession } from "drizzle-orm/pg-proxy/session";

import type { FaceDeps } from "./face.js";

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
  const { engine, partition, driver, writer, pgDialect } = deps;
  const proxyDeps = { driver, writer };
  if (partition !== undefined) Object.assign(proxyDeps, { partition });
  const { callback } = createProxy(proxyDeps);
  const remote: RemoteCallback = (statement, params, method) => callback(statement, params, method);
  const dialect = pgDialect();
  const db: PostgresMeshDb = new PgRemoteDatabase(
    dialect,
    new CapturingSession(remote, dialect),
    undefined,
  );
  const scope = readScope("postgres", deps);
  /** The table as this principal may read it: a subquery with the `read` rule (and the pin) compiled in. */
  const read = <T extends PgTable>(table: T): Source<T> => {
    const name = getTableName(table);
    // SAFETY: pg-core's `from` refuses only a returning-less write subquery, a shape a table can never have; its guard is a conditional type that does not reduce on a type parameter, so the table goes in as its base class
    const source = table as PgTable;
    const aliased = db.select().from(source).where(readPredicate(name, scope)).as(name);
    // SAFETY: the alias wraps exactly the table's columns — what `.as()` would have typed had `from` taken T
    return aliased as unknown as Source<T>;
  };
  return { db, read, live: createLive(engine) };
}
