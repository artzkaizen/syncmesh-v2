import type { SqlRow, SqliteDriver } from "@syncmesh/storage";

import { syncSchema, syncedTables, t } from "@syncmesh/schema";
import { ATTACHED_LOG, schemaName, sqliteDriver, statePath } from "@syncmesh/storage";
import { createIdentity } from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { join } from "node:path";

/** What the crash writer and the crash tests share: the table, the shape, and the one key both open with. */
export const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
export const notesSchema = () =>
  syncSchema({ tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } } });
export const writer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 77 + i)).unwrap();

/**
 * The store under `dataDir` as `bun:sqlite` opens it by default — WAL, `synchronous = NORMAL`, the
 * log attached — with `step` called before every statement reaches the database, transaction
 * control included: where the boundary child counts its way to the statement it dies at.
 */
export const boundaryDriver = (dataDir: string, step: () => void = () => {}): SqliteDriver => {
  const log = join(dataDir, "store.db");
  const db = new Database(statePath(log, schemaName(syncedTables(notesSchema()))), {
    create: true,
    strict: true,
  });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`ATTACH DATABASE ? AS ${ATTACHED_LOG}`, [log]);
  return sqliteDriver({
    exec: (sql) => {
      step();
      db.run(sql);
    },
    run: (sql, params) => {
      step();
      db.run(sql, [...params]);
    },
    all: (sql, params) => {
      step();
      // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
      return db.query(sql).values(...params) as readonly SqlRow[];
    },
    close: () => db.close(),
  });
};
