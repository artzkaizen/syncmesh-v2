import type { StoredEvent } from "@syncmesh/engine";
import type { ColumnName, Logical, PeerId, Procedure, RowKey } from "@syncmesh/kernel";

import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlDriver } from "../driver.js";

import { decodeStatements, statementTarget } from "../journal.js";
import { openStores, schemaName, statePath } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { createWriter } from "../writer.js";
import { openPair } from "./pair.js";

/**
 * A write over both files of a device's SQLite, split at the one boundary a statement-level kill
 * cannot reach: inside `COMMIT`, between the two files (RFC-0022). SQLite commits a WAL `main`
 * before the attached log, so a `kill -9` there leaves the state, the row and the cursor
 * committed and the log as it was before the transaction — what a hot journal rolls it back to.
 *
 * Each case makes that state exactly: a copy of one file taken before the write is put back after
 * it. The reopened store must agree with itself — row, event, ledger row and cursor — and number
 * the next write after it.
 */

const schema = syncSchema({
  tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
});
const tables = [schema.tables.notes];
const DEVICE = parsePeerId("d".repeat(64)).unwrap();
const AUTHOR = parsePeerId("a".repeat(64)).unwrap();
const T0 = 1_700_000_000_000;

/** One store's files under a fresh directory. */
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "syncmesh-journal-"));
  const log = join(dir, "store.db");
  const state = statePath(log, schemaName(tables));
  return { dir, log, state, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/** The engine and a writer over `driver`, opened the way `createMesh` opens them. */
const device = async (driver: SqlDriver) => {
  const stores = (await openStores(driver, { tables })).unwrap();
  const engine = (
    await openEngine({
      peerId: DEVICE,
      clock: createHlcClock({ now: () => Temporal.Now.instant() }),
      store: stores.events,
      stateStore: stores.state,
      atomic: stores.atomic,
    })
  ).unwrap();
  const operations = (await operationStore(stores.driver)).unwrap();
  const validate = createValidator({ schema, grantFor: null, authority: DEVICE });
  const write = createWriter({
    engine,
    validate,
    driver: stores.driver,
    tables,
    schema,
    operations,
  });
  const insert = (id: string) =>
    write("notes.insert", () =>
      stores.driver.run(`INSERT INTO notes (id, body) VALUES (?, ?)`, [id, `body ${id}`]),
    );
  return { stores, engine, insert };
};

const count = async (driver: SqlDriver, sql: string, params: readonly string[] = []) =>
  Number((await driver.all(sql, params))[0]?.[0] ?? 0);

/** What the store says about one author, read four ways that must agree. */
const agreement = async (driver: SqlDriver, author: PeerId, rows: string) => {
  const { engine } = await device(driver);
  return {
    rows: await count(driver, rows),
    events: await count(driver, `SELECT COUNT(*) FROM syncmesh.events WHERE peer = ?`, [author]),
    cursor: Number((await engine.cursors()).unwrap().get(author) ?? 0),
  };
};

/** Copies `path` and its WAL and journal sidecars aside, and puts them back. */
const snapshot = (path: string) => {
  const sidecars = ["", "-wal", "-shm", "-journal"];
  for (const suffix of sidecars)
    if (existsSync(path + suffix)) copyFileSync(path + suffix, `${path}${suffix}.before`);
  return () => {
    for (const suffix of sidecars) {
      rmSync(path + suffix, { force: true });
      if (existsSync(`${path}${suffix}.before`))
        copyFileSync(`${path}${suffix}.before`, path + suffix);
    }
  };
};

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names */
const PROCEDURE = "notes.insert" as Procedure;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** A foreign author's event `n`, inserting row `r<n>`. */
const remote = (n: number): StoredEvent => {
  const seqNum = parseSeqNum(n).unwrap();
  return {
    event: {
      v: 1,
      id: eventId(AUTHOR, seqNum),
      peerId: AUTHOR,
      seqNum,
      // SAFETY: the logical half of a fixture stamp
      hlc: [Temporal.Instant.fromEpochMilliseconds(T0 + n), 0 as Logical],
      procedure: PROCEDURE,
      changes: [
        {
          kind: "insert",
          table: schema.tables.notes.name,
          // SAFETY: `r<n>` from a counter this fixture owns
          key: `r${n}` as RowKey,
          row: new Map([
            [ID, `r${n}`],
            [BODY, `remote ${n}`],
          ]),
        },
      ],
    },
  };
};

describe("a write split between the two files' commits", () => {
  test("the state committed and the log did not: the open replays the log half", async () => {
    const files = scratch();
    try {
      const first = await openPair(files.log, schemaName(tables));
      const { insert } = await device(first);
      const one = (await insert("n1")).unwrap();
      const restore = snapshot(files.log);
      const two = (await insert("n2")).unwrap();
      await first.close?.();
      // the log as the hot journal leaves it: before the second write's transaction
      restore();

      const driver = await openPair(files.log, schemaName(tables));
      const notes = `SELECT COUNT(*) FROM notes`;
      expect(await agreement(driver, DEVICE, notes)).toEqual({ rows: 2, events: 2, cursor: 2 });
      // the ledger row is the log's too, and came back with the event
      const operations = (await operationStore(driver)).unwrap();
      expect((await operations.get(two.operationId ?? "")).unwrap()?.seq).toBe(
        parseSeqNum(2).unwrap(),
      );
      expect((await operations.get(one.operationId ?? "")).unwrap()?.seq).toBe(
        parseSeqNum(1).unwrap(),
      );
      // and the next write follows on, rather than reusing the number the state already holds
      const { insert: next, engine } = await device(driver);
      const three = (await next("n3")).unwrap();
      expect(three.eventId).toBe(eventId(DEVICE, parseSeqNum(3).unwrap()));
      expect(Number((await engine.cursors()).unwrap().get(DEVICE))).toBe(3);
      await driver.close?.();
    } finally {
      files.done();
    }
  });

  test("a received batch split the same way: the open replays it", async () => {
    const files = scratch();
    try {
      const first = await openPair(files.log, schemaName(tables));
      const { engine } = await device(first);
      (await engine.receiveBatch([remote(1), remote(2)])).unwrap();
      const restore = snapshot(files.log);
      (await engine.receiveBatch([remote(3), remote(4)])).unwrap();
      await first.close?.();
      restore();

      const driver = await openPair(files.log, schemaName(tables));
      expect(await agreement(driver, AUTHOR, `SELECT COUNT(*) FROM notes`)).toEqual({
        rows: 4,
        events: 4,
        cursor: 4,
      });
      await driver.close?.();
    } finally {
      files.done();
    }
  });

  test("the log committed and the state did not: boot replays the log above the cursor", async () => {
    const files = scratch();
    try {
      const first = await openPair(files.log, schemaName(tables));
      const { insert } = await device(first);
      (await insert("n1")).unwrap();
      const restore = snapshot(files.state);
      (await insert("n2")).unwrap();
      await first.close?.();
      restore();

      const driver = await openPair(files.log, schemaName(tables));
      expect(await agreement(driver, DEVICE, `SELECT COUNT(*) FROM notes`)).toEqual({
        rows: 2,
        events: 2,
        cursor: 2,
      });
      await driver.close?.();
    } finally {
      files.done();
    }
  });

  test("a transaction that writes one file is not journaled, and a journal entry round-trips", async () => {
    const driver = await openPair();
    const { stores, insert } = await device(driver);
    (await insert("n1")).unwrap();
    const [row] = await driver.all(`SELECT n, statements FROM syncmesh_journal`);
    const bytes = row?.[1];
    expect(bytes).toBeInstanceOf(Uint8Array);
    const statements = decodeStatements(bytes instanceof Uint8Array ? bytes : new Uint8Array())
      .unwrap()
      .map(([sql]) => statementTarget(sql));
    // the event, the ledger row and the mark: every statement in it writes the log
    expect(statements.length).toBeGreaterThanOrEqual(3);
    expect(new Set(statements)).toEqual(new Set(["log"]));
    // an append alone commits in one file: nothing to journal, so the entry is the write's still
    (await stores.events.appendBatch([remote(1)])).unwrap();
    expect((await driver.all(`SELECT n FROM syncmesh_journal`))[0]?.[0]).toBe(row?.[0] ?? null);
  });

  test("which file a statement writes", () => {
    expect(statementTarget(`INSERT OR IGNORE INTO syncmesh.events (peer) VALUES (?)`)).toBe("log");
    expect(statementTarget(`DELETE FROM syncmesh.events WHERE peer = ?`)).toBe("log");
    expect(statementTarget(`UPDATE syncmesh.operations SET status = 'x'`)).toBe("log");
    expect(statementTarget(`INSERT OR REPLACE INTO syncmesh_state_rows VALUES (?)`)).toBe("main");
    expect(statementTarget(`insert into "notes" ("id") values (?)`)).toBe("main");
    expect(statementTarget(`SELECT * FROM syncmesh.events`)).toBeUndefined();
    expect(statementTarget(`PRAGMA syncmesh.user_version`)).toBeUndefined();
    expect(statementTarget(`PRAGMA syncmesh.user_version = 3`)).toBe("log");
    expect(statementTarget(`CREATE TABLE IF NOT EXISTS syncmesh.gaps (a)`)).toBe("log");
    expect(statementTarget(`WITH x AS (SELECT 1) INSERT INTO syncmesh.gaps SELECT * FROM x`)).toBe(
      "log",
    );
    expect(statementTarget(`WITH x AS (SELECT 1) DELETE FROM notes`)).toBe("main");
    expect(statementTarget(`WITH x AS (SELECT 1) SELECT * FROM x`)).toBeUndefined();
  });
});
