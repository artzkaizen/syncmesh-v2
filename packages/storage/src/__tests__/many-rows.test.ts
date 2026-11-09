import { describe, expect, test } from "bun:test";

import type { SqlDialect, SqlDriver, SqlValue } from "../driver.js";

import { insertRows } from "../many-rows.js";

/** A driver that runs nothing and keeps every statement it was handed. */
const recording = (dialect: SqlDialect) => {
  const ran: { readonly sql: string; readonly params: readonly SqlValue[] }[] = [];
  const driver: SqlDriver = {
    dialect,
    run: (sql, params = []) => {
      ran.push({ sql, params });
      return Promise.resolve();
    },
    all: () => Promise.resolve([]),
  };
  return { driver, ran };
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => [`k${i}`, i]);

describe("insertRows", () => {
  test("sends a batch as power-of-two chunks, every row once and in order", async () => {
    const { driver, ran } = recording("sqlite");
    await insertRows(driver, "INSERT INTO t (k, v) VALUES (?, ?)", rows(1_300));
    expect(ran.map(({ params }) => params.length / 2)).toEqual([512, 512, 256, 16, 4]);
    expect(ran.flatMap(({ params }) => params)).toEqual(rows(1_300).flat());
    expect(ran[4]?.sql).toBe("INSERT INTO t (k, v) VALUES (?, ?), (?, ?), (?, ?), (?, ?)");
  });

  test("numbers Postgres binds row by row and keeps the tail and its casts", async () => {
    const { driver, ran } = recording("postgres");
    const sql = "INSERT INTO t (k, v) VALUES ($1, $2::text::jsonb) ON CONFLICT (k) DO NOTHING";
    await insertRows(driver, sql, rows(3));
    expect(ran.map(({ sql: text }) => text)).toEqual([
      "INSERT INTO t (k, v) VALUES ($1, $2::text::jsonb), ($3, $4::text::jsonb) ON CONFLICT (k) DO NOTHING",
      sql,
    ]);
  });

  test("keeps a statement under the bind limit, however wide its rows", async () => {
    const { driver, ran } = recording("postgres");
    const width = 100;
    const marks = Array.from({ length: width }, (_, i) => `$${i + 1}`).join(", ");
    const wide = Array.from({ length: 1_000 }, () => Array.from({ length: width }, () => 0));
    await insertRows(driver, `INSERT INTO t VALUES (${marks})`, wide);
    expect(Math.max(...ran.map(({ params }) => params.length))).toBeLessThanOrEqual(30_000);
    expect(ran.reduce((n, { params }) => n + params.length, 0)).toBe(100_000);
  });

  test("runs nothing for no rows, and refuses a bind outside the tuple", async () => {
    const { driver, ran } = recording("sqlite");
    await insertRows(driver, "INSERT INTO t (k) VALUES (?)", []);
    expect(ran).toHaveLength(0);
    expect(
      insertRows(driver, "INSERT INTO t (k) VALUES (?) RETURNING ?", [[1, 2]]),
    ).rejects.toThrow(/outside the VALUES tuple/);
  });
});
