import type { ChangeMappings, SourceRow } from "@syncmesh/cdc";
import type { SyncEvent } from "@syncmesh/kernel";
import type { SqlDriver } from "@syncmesh/storage";

import { startCapture } from "@syncmesh/cdc";
import { openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { scalarText, syncSchema, t } from "@syncmesh/schema";
import { openStores, stagedChangeSource } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { afterAll, describe, expect, test } from "bun:test";

import { postgresDriver } from "../index.js";

const url = process.env.SYNCMESH_PG_URL ?? "";

/**
 * A staged table on a real Postgres (RFC-0025), with the outside writer on a connection of its
 * own: its transactions commit while sweeps run, which is where the queue's commit order and the
 * placing of a row the mesh has not folded yet are actually tested.
 */

const schema = syncSchema({
  tables: {
    tasks: {
      columns: {
        id: t.text().primaryKey(),
        orgId: t.text(),
        title: t.text(),
        status: t.text(),
      },
    },
  },
});
const tables = [schema.tables.tasks];
const TASKS = schema.tables.tasks.name;
const ACME = parsePartitionKey("org:acme").unwrap();
const AUTHORITY = parsePeerId("c".repeat(64)).unwrap();
const EVERY = Temporal.Duration.from({ milliseconds: 5 });

const mappings = {
  tasks: {
    collection: schema.tables.tasks,
    partition: (row: SourceRow) => {
      const org = scalarText(row["orgId"]);
      return scalarText(row["_partition"]) ?? (org === undefined ? undefined : `org:${org}`);
    },
  },
} satisfies ChangeMappings;

const pause = (duration: Temporal.Duration) =>
  new Promise((resolve) => setTimeout(resolve, duration.total("milliseconds")));

const eventually = async (check: () => boolean | Promise<boolean>, what: string) => {
  const until = Temporal.Now.instant().add({ seconds: 10 });
  while (!(await check())) {
    if (Temporal.Instant.compare(Temporal.Now.instant(), until) > 0)
      throw new Error(`never: ${what}`);
    await pause(EVERY);
  }
};

describe.if(url !== "")(
  "@syncmesh/postgres: a staged table written from another connection",
  () => {
    const stamp = Date.now().toString(36);
    const databases: string[] = [];
    const roles: string[] = [];
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
      return () => {
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
      for (const role of roles) await root.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await root.end();
    });

    /** The authority over its own connection, with `tasks` staged, sweeping through `driver`. */
    const authority = async (
      driver: SqlDriver,
      seed: () => Promise<void> = async () => {},
      sweeping?: (driver: SqlDriver) => SqlDriver,
    ) => {
      const stores = (await openStores(driver, { tables, strict: { stage: ["tasks"] } })).unwrap();
      await seed();
      const engine = (
        await openEngine({
          peerId: AUTHORITY,
          clock: createHlcClock({ now: () => Temporal.Now.instant() }),
          store: stores.events,
          stateStore: stores.state,
          atomic: stores.atomic,
          merge: schema.merge,
        })
      ).unwrap();
      const sent: SyncEvent[] = [];
      engine.onOutbound((event) => void sent.push(event));
      const source = stagedChangeSource({
        name: "staged",
        driver: sweeping?.(stores.driver) ?? stores.driver,
        tables,
        every: EVERY,
      });
      const running = (await startCapture({ engine, source, mappings })).unwrap();
      const status = (id: string) => {
        const found = [...engine.rowsIn(TASKS, ACME)].find(([key]) => key === id)?.[1];
        return found === undefined ? undefined : Object.fromEntries(found)["status"];
      };
      return { engine, sent, source, running, status };
    };

    /** Every change to `tasks` that left the authority, as `partition kind key`. */
    const filed = (sent: readonly SyncEvent[]) =>
      sent.flatMap((event) =>
        event.changes
          .filter((change) => change.table === TASKS)
          .map((change) => `${String(event.partition)} ${change.kind} ${change.key}`),
      );

    test("writes committed between and across sweeps reach the mesh in commit order", async () => {
      const open = await fresh("staged_order");
      const own = open();
      const { sent, source, running, status } = await authority(own.driver);
      const outside = open().client;

      await outside`INSERT INTO tasks (id, "orgId", title, status) VALUES ('t1', 'acme', 'one', '0')`;
      for (let step = 1; step <= 20; step += 1) {
        await outside`UPDATE tasks SET status = ${String(step)} WHERE id = 't1'`;
        if (step % 3 === 0) source.sweep();
      }
      // a transaction still open while sweeps run is taken by a sweep after it commits
      await outside.begin(async (tx) => {
        await tx`UPDATE tasks SET status = 'held' WHERE id = 't1'`;
        source.sweep();
        await pause(Temporal.Duration.from({ milliseconds: 50 }));
        await tx`UPDATE tasks SET status = 'last' WHERE id = 't1'`;
      });

      await eventually(() => status("t1") === "last", "the last committed write");
      await eventually(async () => (await source.pending()).unwrap() === 0, "the queue drained");
      running.stop();
      (await running.done).unwrap();
      const [row] = await own.client`SELECT status, "_partition" FROM tasks WHERE id = 't1'`;
      expect([row?.["status"], row?.["_partition"]]).toEqual(["last", "org:acme"]);
      expect(new Set(filed(sent).map((line) => line.split(" ")[0]))).toEqual(new Set(["org:acme"]));
    });

    test("a service whose role may write only the table has its writes staged", async () => {
      const open = await fresh("staged_role");
      const own = open();
      const { sent, running, status } = await authority(own.driver);
      const role = `syncmesh_svc_${stamp}`;
      roles.push(role);
      await own.client.unsafe(`CREATE ROLE "${role}"`);
      await own.client.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO "${role}"`);
      // a hardened database: no role but the authority's may name the log or the queue
      await own.client.unsafe(`REVOKE ALL ON SCHEMA syncmesh FROM PUBLIC`);
      const outside = open().client;
      await outside.unsafe(`SET ROLE "${role}"`);

      await outside`INSERT INTO tasks (id, "orgId", title, status) VALUES ('t1', 'acme', 'one', 'open')`;
      await eventually(() => status("t1") === "open", "the service's insert");
      await outside`UPDATE tasks SET status = 'done' WHERE id = 't1'`;
      await eventually(() => status("t1") === "done", "the service's update");
      running.stop();
      (await running.done).unwrap();
      expect(filed(sent)).toEqual(["org:acme insert t1", "org:acme update t1"]);
      // the staging function runs as its owner, and only its trigger may run it
      const [callable] = await own.client.unsafe(
        `SELECT has_function_privilege($1, 'syncmesh."stage_tasks"()', 'EXECUTE') AS run`,
        [role],
      );
      expect(callable?.["run"]).toBe(false);
    });

    test("an update committed before the fold placed its row is filed in the row's instance", async () => {
      const open = await fresh("staged_race");
      const own = open();
      const outside = open().client;
      // the other connection's update commits right after the first sweep took the insert, so the
      // guard files it with no `_partition` and the update carries only `status`
      let raced = false;
      const seed = async () => {
        await outside`INSERT INTO tasks (id, "orgId", title, status) VALUES ('t1', 'acme', 'one', 'open')`;
      };
      const { sent, running, status } = await authority(own.driver, seed, (driver) => ({
        ...driver,
        run: async (sql, params) => {
          await driver.run(sql, params);
          if (raced || !sql.includes("SET sweep")) return;
          raced = true;
          await outside`UPDATE tasks SET status = 'done' WHERE id = 't1'`;
        },
      }));

      await eventually(() => status("t1") === "done", "the raced update");
      running.stop();
      (await running.done).unwrap();
      expect(raced).toBe(true);
      expect(filed(sent)).toEqual(["org:acme insert t1", "org:acme update t1"]);
    });
  },
);
