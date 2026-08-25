import type { SqliteDriver } from "./driver.js";

/** Applied in order on open; `PRAGMA user_version` records how many have run. */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS events (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      local INTEGER NOT NULL,
      hlc_ms INTEGER NOT NULL,
      hlc_logical INTEGER NOT NULL,
      partition TEXT,
      core BLOB NOT NULL,
      PRIMARY KEY (peer, seq, local)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS events_hlc ON events (hlc_ms, hlc_logical)`,
    `CREATE TABLE IF NOT EXISTS state_rows (
      tbl TEXT NOT NULL,
      key TEXT NOT NULL,
      record BLOB NOT NULL,
      PRIMARY KEY (tbl, key)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS state_cursors (
      peer TEXT NOT NULL,
      local INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (peer, local)
    ) WITHOUT ROWID`,
  ],
];

/** Brings the database up to the current schema; a no-op when it already is. */
export async function migrate(driver: SqliteDriver): Promise<void> {
  const [row] = await driver.all("PRAGMA user_version");
  const applied = Number(row?.[0] ?? 0);
  for (const step of MIGRATIONS.slice(applied)) for (const sql of step) await driver.run(sql);
  await driver.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
}
