import type { SqlDriver } from "@syncmesh/storage";

import { sqlEventStore } from "@syncmesh/storage";
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
 * Two processes appending one author's events to one Postgres log (D39). Each reads the author's
 * head before it records the gap its event makes; read concurrently, both start their gap from
 * the same head and the second row is dropped on the key, so a healthy log reads as torn.
 */
describe.if(url !== "")("@syncmesh/postgres: two writers on one log", () => {
  const database = `syncmesh_race_${Date.now().toString(36)}`;
  const at = new URL(url);
  at.pathname = `/${database}`;
  const clients: { end: () => Promise<void> }[] = [];

  const open = async () => {
    const { default: postgres } = await import("postgres");
    const client = postgres(at.toString(), { max: 1, onnotice: console.log });
    clients.push(client);
    return { client, driver: postgresDriver(client) };
  };

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
    const { default: postgres } = await import("postgres");
    const root = postgres(url, { max: 1 });
    await root.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await root.end();
  });

  test("record every gap when one appends while the other has read the head", async () => {
    const { default: postgres } = await import("postgres");
    const root = postgres(url, { max: 1 });
    await root.unsafe(`CREATE DATABASE "${database}"`);
    await root.end();

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
});
