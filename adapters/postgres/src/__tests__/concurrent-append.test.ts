import type { RowKey, TableName } from "@syncmesh/kernel";
import type { SqlDriver } from "@syncmesh/storage";

import { hlcOf } from "@syncmesh/kernel";
import { hashOf, sqlBlobLedger, sqlEventStore } from "@syncmesh/storage";
import { CRASH_AUTHOR, entry } from "@syncmesh/storage/driver-tests";
import { Temporal } from "@syncmesh/temporal";
import { afterAll, describe, expect, test } from "bun:test";

import { postgresDriver } from "../index.js";

const url = process.env.SYNCMESH_PG_URL ?? "";
/** How often the watching connection looks for a writer waiting on a lock. */
const POLL = Temporal.Duration.from({ milliseconds: 10 });

const pause = (duration: Temporal.Duration) =>
  new Promise((resolve) => setTimeout(resolve, duration.total("milliseconds")));

/**
 * Two connections on one Postgres log (D39). Two writers each read the author's head before they
 * record the gap their event makes; read concurrently, both start their gap from the same head and
 * the second row is dropped on the key. A reader takes the entries and the gaps in separate
 * statements, and a writer filling a gap between them deletes the row the reader needed. Either
 * way a healthy log reads as torn.
 */
describe.if(url !== "")("@syncmesh/postgres: two connections on one log", () => {
  const stamp = Date.now().toString(36);
  const databases: string[] = [];
  const clients: { end: () => Promise<void> }[] = [];

  /** A fresh database for one case, and a way to open connections on it. */
  const fresh = async (name: string) => {
    const database = `syncmesh_${name}_${stamp}`;
    const { default: postgres } = await import("postgres");
    const root = postgres(url, { max: 1 });
    await root.unsafe(`CREATE DATABASE "${database}"`);
    await root.end();
    databases.push(database);
    const at = new URL(url);
    at.pathname = `/${database}`;
    return async () => {
      const client = postgres(at.toString(), { max: 1, onnotice: console.log });
      clients.push(client);
      return { client, driver: postgresDriver(client) };
    };
  };

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    const { default: postgres } = await import("postgres");
    const root = postgres(url, { max: 1 });
    for (const database of databases)
      await root.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await root.end();
  });

  test("record every gap when one appends while the other has read the head", async () => {
    const open = await fresh("race");
    const first = await open();
    const s1 = (await sqlEventStore(first.driver)).unwrap();
    (await s1.appendBatch([1, 2, 3, 4].map((n) => entry(CRASH_AUTHOR, n, n * 10)))).unwrap();

    const watcher = await open();
    let settled = false;
    const waiting = async () => {
      while (!settled) {
        const rows = await watcher.client`SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        if (rows.length > 0) return "waiting";
        await pause(POLL);
      }
      return "done";
    };

    // the second writer, stopped right after it reads A's head: the first appends A:7 there, and
    // the second goes on only once that append has committed or is queued behind its lock
    const second = await open();
    let raced: Promise<unknown> | undefined;
    const pausing: SqlDriver = {
      ...second.driver,
      all: async (sql, values) => {
        const rows = await second.driver.all(sql, values);
        if (raced === undefined && sql.startsWith("SELECT MAX(seq)")) {
          raced = s1.append(entry(CRASH_AUTHOR, 7, 70)).then((r) => {
            settled = true;
            return r.unwrap();
          });
          await Promise.race([raced, waiting()]);
        }
        return rows;
      },
    };
    const s2 = (await sqlEventStore(pausing)).unwrap();
    (await s2.append(entry(CRASH_AUTHOR, 10, 100))).unwrap();
    await raced;

    const read = await s1.all();
    const held = [1, 2, 3, 4, 7, 10].map((n) => entry(CRASH_AUTHOR, n, n * 10).event.id);
    expect(read.isOk() ? read.value.map((e) => e.event.id) : read.error.message).toEqual(held);
    const gaps = await first.client`SELECT from_seq, to_seq FROM syncmesh.gaps ORDER BY from_seq`;
    expect(gaps.map((g) => [Number(g.from_seq), Number(g.to_seq)])).toEqual([
      [5, 6],
      [8, 9],
    ]);
  });

  test("a read that finds a hole looks again with the entries and the gaps from one snapshot", async () => {
    const open = await fresh("reread");
    const writer = await open();
    const ws = (await sqlEventStore(writer.driver)).unwrap();
    (await ws.appendBatch([1, 2, 4, 6].map((n) => entry(CRASH_AUTHOR, n, n * 10)))).unwrap();

    // the writer fills a gap right after each read of the entries: 3 after the first read, which
    // then shows a hole, and 5 after the second, which is inside the reader's snapshot
    const reader = await open();
    const fills = [3, 5];
    const racing: SqlDriver = {
      ...reader.driver,
      all: async (sql, values) => {
        const rows = await reader.driver.all(sql, values);
        const fill = sql.startsWith("SELECT e.core") ? fills.shift() : undefined;
        if (fill !== undefined) (await ws.append(entry(CRASH_AUTHOR, fill, fill * 10))).unwrap();
        return rows;
      },
    };
    const rs = (await sqlEventStore(racing)).unwrap();
    const read = await rs.allSince(new Map());
    const seen = [1, 2, 3, 4, 6].map((n) => entry(CRASH_AUTHOR, n, n * 10).event.id);
    expect(read.isOk() ? read.value.map((e) => e.event.id) : read.error.message).toEqual(seen);
    expect(fills).toEqual([]);
  });

  test("two ledgers saving one row at once both land: the later write and the delete", async () => {
    const open = await fresh("ledger");
    const first = await open();
    const l1 = (await sqlBlobLedger(first.driver)).unwrap();
    const watcher = await open();
    let settled = false;
    const waiting = async () => {
      while (!settled) {
        const rows = await watcher.client`SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        if (rows.length > 0) return "waiting";
        await pause(POLL);
      }
      return "done";
    };

    // SAFETY: test fixture names; the brands are over these strings
    const row = {
      table: "notes" as TableName,
      key: "n1" as RowKey,
      hashes: [hashOf(Uint8Array.of(1))],
    };
    const stamp = (ms: number) => ({ hlc: hlcOf(ms, 0), peer: CRASH_AUTHOR });
    const state = (written: number, deleted: number | undefined) => ({
      rows: [
        {
          ...row,
          written: stamp(written),
          deleted: deleted === undefined ? undefined : stamp(deleted),
        },
      ],
      windows: [],
      sealed: [],
      complete: undefined,
    });

    // the second ledger, stopped right after it reads the row: the first saves its delete there,
    // and the second goes on only once that save has committed or is queued behind its lock
    const second = await open();
    let raced: Promise<unknown> | undefined;
    const pausing: SqlDriver = {
      ...second.driver,
      all: async (sql, values) => {
        const rows = await second.driver.all(sql, values);
        if (raced === undefined && sql.startsWith("SELECT tbl, row_key")) {
          raced = l1.save(state(1_700_000_000_000, 1_700_000_000_500)).then((r) => {
            settled = true;
            return r.unwrap();
          });
          await Promise.race([raced, waiting()]);
        }
        return rows;
      },
    };
    const l2 = (await sqlBlobLedger(pausing)).unwrap();
    (await l2.save(state(1_700_000_000_900, undefined))).unwrap();
    await raced;

    const kept = (await l1.load()).unwrap().rows;
    expect(kept.map((r) => [r.written?.hlc, r.deleted?.hlc])).toEqual([
      [hlcOf(1_700_000_000_900, 0), hlcOf(1_700_000_000_500, 0)],
    ]);
  });
});
