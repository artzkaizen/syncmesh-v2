import type { SqlRow, SqliteBinding } from "@syncmesh/storage";

import type { OpenedDatabase } from "./vfs.js";

/**
 * SQLite's `oo1` API as the four calls the port asks for — the ~8 lines this binding genuinely
 * differs by, and the only place in this package that speaks to a database.
 *
 * Declared once because it is needed twice and the two must not drift: `wasmSqliteDriver` wraps it
 * for a database on the caller's own thread, and {@link serveSqlite} drives the same binding from
 * the other end of a `MessagePort` for a database in a worker. A statement that behaves one way in
 * a test runner and another in a browser would be the whole bug.
 */
export const bindingFor = ({ db, release }: OpenedDatabase): SqliteBinding => ({
  exec: (sql) => void db.exec(sql),
  run: (sql, params) => void db.exec({ sql, bind: [...params] }),
  all: (sql, params) =>
    // SAFETY: SQLite hands back text, integers (number or bigint), reals, blobs as Uint8Array
    // and NULL; the declared union is wider only because the same type names what `bind` takes
    db.exec({
      sql,
      bind: [...params],
      rowMode: "array",
      returnValue: "resultRows",
    }) as readonly SqlRow[],
  close: () => {
    db.close();
    release();
  },
});
