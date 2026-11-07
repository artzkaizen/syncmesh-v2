import { t, table } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import type { Rung } from "../ladder.js";

import { ladder } from "../ladder.js";
import { openStores } from "../open-stores.js";
import { openPair } from "./pair.js";

/**
 * Format upgrades (gap audit №13): a store written by an older build climbs to this one's top,
 * applying only the steps above where it stands, and a climb interrupted part-way leaves the
 * database at a step it can resume from rather than one it can never open again.
 *
 * The shipped ladders have one step each, so the upgrade path is proven on a synthetic ladder
 * over the same `ladder()` both dialects climb, with the position in a `meta` row as Postgres and
 * the inline log keep it.
 */

const TABLES = [table("notes", { id: t.text().primaryKey(), body: t.text() })];

const metaRung: Rung = {
  read: async (driver) => {
    await driver.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const [row] = await driver.all(`SELECT value FROM meta WHERE key = 'version'`, []);
    return Number(row?.[0] ?? 0);
  },
  write: (driver, step) =>
    driver.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`, [`${step}`]),
};

/** Three steps, the last two not idempotent: re-running either one is an error. */
const STEPS = [
  [`CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY)`],
  [`ALTER TABLE things ADD COLUMN size INTEGER`],
  [`ALTER TABLE things ADD COLUMN colour TEXT`, `CREATE INDEX things_colour ON things (colour)`],
];

const columns = async (driver: Awaited<ReturnType<typeof openPair>>) =>
  (await driver.all(`SELECT name FROM pragma_table_info('things')`, [])).map((r) => r[0]);

describe("a store written by an older build", () => {
  test("climbs from where it stands, applying only the steps above it", async () => {
    const driver = await openPair();
    await ladder(driver, metaRung, STEPS.slice(0, 1));
    expect(await metaRung.read(driver)).toBe(1);
    await ladder(driver, metaRung, STEPS);
    expect(await metaRung.read(driver)).toBe(3);
    expect(await columns(driver)).toEqual(["id", "size", "colour"]);
    // and at the top it touches nothing: a second launch is a no-op, not a re-run
    await ladder(driver, metaRung, STEPS);
    expect(await metaRung.read(driver)).toBe(3);
    await driver.close?.();
  });

  test("a climb that dies part-way resumes from the last step it finished", async () => {
    const driver = await openPair();
    await ladder(driver, metaRung, STEPS.slice(0, 1));
    // step 3 dies on its second statement, the way a kill between them would leave it
    const dying = [...STEPS.slice(0, 2), [STEPS[2]?.[0] ?? "", `this is not sql`]];
    const died = await ladder(driver, metaRung, dying).then(
      () => false,
      () => true,
    );
    expect(died).toBe(true);
    // step 2 committed with its position; step 3 left nothing behind
    expect(await metaRung.read(driver)).toBe(2);
    expect(await columns(driver)).toEqual(["id", "size"]);
    // so the next launch, with the whole ladder, finishes the climb instead of failing at step 2
    await ladder(driver, metaRung, STEPS);
    expect(await metaRung.read(driver)).toBe(3);
    expect(await columns(driver)).toEqual(["id", "size", "colour"]);
    await driver.close?.();
  });
});

describe("the shipped ladders", () => {
  test("SQLite: both halves' user_version sit at their top after open, and reopen is a no-op", async () => {
    const driver = await openPair();
    (await openStores(driver, { tables: TABLES })).unwrap();
    const log = Number((await driver.all(`PRAGMA syncmesh.user_version`, []))[0]?.[0]);
    const state = Number((await driver.all(`PRAGMA main.user_version`, []))[0]?.[0]);
    expect([log, state]).toEqual([1, 1]);
    (await openStores(driver, { tables: TABLES })).unwrap();
    expect(Number((await driver.all(`PRAGMA syncmesh.user_version`, []))[0]?.[0])).toBe(1);
    await driver.close?.();
  });
});
