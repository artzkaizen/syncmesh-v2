import { describe, expect, test } from "bun:test";

import { createSqlDoor, refusalFor } from "../source/sql.js";

/**
 * The door is a speed bump and not a boundary, so what is tested is that the bump is in the right
 * place: the shapes that turn a read into a write are refused by name, and the reading a devtool
 * is actually owed — the weight of the log — still goes through.
 */

describe("the read-only SQL door", () => {
  test("carries a SELECT", () => {
    expect(refusalFor("SELECT peer, COUNT(*) FROM syncmesh_events GROUP BY peer")).toBeUndefined();
  });

  test("carries a PRAGMA, which is how a device is asked about its own migration", () => {
    expect(refusalFor("PRAGMA user_version")).toBeUndefined();
  });

  test.each([
    ["INSERT INTO issue (id) VALUES ('x')"],
    ["update issue set title = 'x'"],
    ["DELETE FROM issue"],
    ["DROP TABLE events"],
    ["WITH gone AS (DELETE FROM issue RETURNING *) SELECT * FROM gone"],
  ])("refuses %s", (sql) => {
    expect(refusalFor(sql)).toContain("SELECT or PRAGMA");
  });

  test("refuses a second statement after a semicolon", () => {
    expect(refusalFor("SELECT 1; DELETE FROM syncmesh_events")).toContain(
      "one statement at a time",
    );
  });

  test("a trailing semicolon is punctuation, not a second statement", () => {
    expect(refusalFor("SELECT 1;")).toBeUndefined();
  });

  test("refuses the core column, which is the bytes an author signed", () => {
    expect(refusalFor("SELECT core FROM syncmesh_events")).toContain("length(core)");
  });

  test("carries the weight of the log, which is the reading a devtool is owed", () => {
    expect(refusalFor("SELECT SUM(length(core)) FROM syncmesh_events")).toBeUndefined();
    expect(refusalFor("SELECT octet_length( core ) FROM syncmesh.events")).toBeUndefined();
  });

  test("a refusal is a value, and the database is never asked", async () => {
    let asked = 0;
    const door = createSqlDoor(() => {
      asked += 1;
      return Promise.resolve([]);
    });
    const answer = await door.query("DELETE FROM syncmesh_events");
    expect(answer.isErr()).toBe(true);
    expect(asked).toBe(0);
  });

  test("a driver that throws comes back as a value, not as a rejection", async () => {
    const door = createSqlDoor(() => Promise.reject(new Error("no such table: events")));
    const answer = await door.query("SELECT 1 FROM syncmesh_events");
    expect(answer.isErr()).toBe(true);
  });
});
