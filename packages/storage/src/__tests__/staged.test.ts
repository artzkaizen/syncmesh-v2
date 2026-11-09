import type { ChangeMappings, SourceRow } from "@syncmesh/cdc";
import type { SyncEvent } from "@syncmesh/kernel";

import { startCapture, storedWatermark } from "@syncmesh/cdc";
import { createValidator, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { scalarText, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { SqlDriver } from "../driver.js";

import { folding } from "../guard.js";
import { openStores, schemaName } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { stagedChangeSource } from "../staged.js";
import { createWriter } from "../writer.js";
import { openPair } from "./pair.js";

/**
 * A staged table end to end (RFC-0025, class c): the authority's own Postgres or SQLite table,
 * written by the mesh and by something outside it. The outside write is filed by the guard, swept
 * by `stagedChangeSource`, signed by the authority through `startCapture`, and folded back into
 * the same table without being filed again.
 */

const schema = syncSchema({
  tables: {
    tasks: {
      columns: {
        id: t.text().primaryKey(),
        orgId: t.text(),
        title: t.text(),
        status: t.text(),
        views: t.integer({ merge: "counter" }).nullable(),
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

/** The authority over its own database, with `tasks` staged. */
const authority = async (driver: SqlDriver) => {
  const stores = (await openStores(driver, { tables, strict: { stage: ["tasks"] } })).unwrap();
  const engine = (
    await openEngine({
      peerId: AUTHORITY,
      clock: createHlcClock({ now: () => Temporal.Now.instant() }),
      store: stores.events,
      stateStore: stores.state,
      atomic: stores.atomic,
    })
  ).unwrap();
  const sent: SyncEvent[] = [];
  engine.onOutbound((event) => void sent.push(event));
  const source = stagedChangeSource({
    name: "staged",
    driver: stores.driver,
    tables,
    every: EVERY,
  });
  const write = createWriter({
    engine,
    validate: createValidator({ schema, grantFor: null, authority: AUTHORITY }),
    driver: stores.driver,
    tables,
    schema,
    operations: (await operationStore(stores.driver)).unwrap(),
  });
  return { stores, engine, sent, source, write };
};

const eventually = async (check: () => boolean | Promise<boolean>, what: string) => {
  const until = Temporal.Now.instant().add({ seconds: 5 });
  while (!(await check())) {
    if (Temporal.Instant.compare(Temporal.Now.instant(), until) > 0)
      throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const row = (engine: Awaited<ReturnType<typeof authority>>["engine"], id: string) => {
  const found = [...engine.rowsIn(TASKS, ACME)].find(([key]) => key === id)?.[1];
  return found === undefined ? undefined : Object.fromEntries(found);
};

/** The update patches of every event sent after the first `skip`, as plain objects. */
const patchesAfter = (sent: readonly SyncEvent[], skip: number) =>
  sent
    .slice(skip)
    .flatMap((event) => event.changes)
    .flatMap((change) =>
      change.kind === "update" && change.table === TASKS ? [Object.fromEntries(change.patch)] : [],
    );

const tableRows = async (driver: SqlDriver) =>
  (await driver.all(`SELECT id, title, status, "_partition" FROM tasks ORDER BY id`)).map((cells) =>
    cells.map(String).join(" "),
  );

describe("a staged table, written by the mesh and by something outside it", () => {
  test("the outside write is swept into one signed event, folded back without being filed again", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const { stores, engine, sent, source, write } = await authority(driver);
    // the authority's own procedure, captured
    (
      await write(
        "tasks.create",
        () =>
          stores.driver.run(
            `INSERT INTO tasks (id, orgId, title, status) VALUES ('t1', 'acme', 'from the mesh', 'open')`,
          ),
        { partition: ACME },
      )
    ).unwrap();

    // another service, knowing nothing of syncmesh
    await stores.driver.run(`UPDATE tasks SET status = 'done' WHERE id = 't1'`);
    await stores.driver.run(
      `INSERT INTO tasks (id, orgId, title, status) VALUES ('t2', 'acme', 'from outside', 'open')`,
    );

    const running = (await startCapture({ engine, source, mappings })).unwrap();
    await eventually(() => row(engine, "t2") !== undefined, "the outside insert");
    expect(row(engine, "t1")).toEqual({
      id: "t1",
      orgId: "acme",
      title: "from the mesh",
      status: "done",
      views: null,
    });
    const swept = sent.filter((event) => event.partition === ACME).slice(1);
    expect(swept).toHaveLength(1);
    expect(swept[0]?.peerId).toBe(AUTHORITY);
    // only the column the outside writer changed: a concurrent mesh edit to the title survives
    expect(
      swept[0]?.changes.map((change) =>
        change.kind === "update"
          ? `update ${change.key} ${[...change.patch.keys()].join(",")}`
          : `${change.kind} ${change.key}`,
      ),
    ).toEqual(["update t1 status", "insert t2"]);

    // the fold placed the outside row and wrote it back, and filed nothing doing so
    expect(await tableRows(stores.driver)).toEqual([
      "t1 from the mesh done org:acme",
      "t2 from outside open org:acme",
    ]);
    await eventually(async () => (await source.pending()).unwrap() === 0, "the queue drained");
    const settled = sent.length;
    source.sweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(settled);

    running.stop();
    const report = (await running.done).unwrap();
    expect(report.transactions).toBe(1);
    expect(storedWatermark(engine, source.name)).toBe(report.watermark);
  });

  test("a mesh write between two outside writes to one row is not signed again by the sweep", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const { stores, engine, sent, source, write } = await authority(driver);
    const captured = async (name: string, sql: string) =>
      (await write(name, () => stores.driver.run(sql), { partition: ACME })).unwrap();
    await captured(
      "tasks.create",
      `INSERT INTO tasks (id, orgId, title, status) VALUES ('t1', 'acme', 'first', 'open')`,
    );
    await stores.driver.run(`UPDATE tasks SET status = 'a' WHERE id = 't1'`);
    await captured("tasks.update", `UPDATE tasks SET title = 'mesh title' WHERE id = 't1'`);
    await stores.driver.run(`UPDATE tasks SET status = 'b' WHERE id = 't1'`);
    const meshed = sent.length;

    const running = (await startCapture({ engine, source, mappings })).unwrap();
    await eventually(() => row(engine, "t1")?.["status"] === "b", "the outside writes");
    running.stop();
    (await running.done).unwrap();

    // the title is the mesh's own write and keeps the mesh's stamp: a later device edit to it wins
    expect(patchesAfter(sent, meshed)).toEqual([{ status: "b" }]);
    expect(row(engine, "t1")).toEqual({
      id: "t1",
      orgId: "acme",
      title: "mesh title",
      status: "b",
      views: null,
    });
  });

  test("a counter moves by the outside writer's increments, not by a fold's between them", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const { stores, engine, sent, source, write } = await authority(driver);
    (
      await write(
        "tasks.create",
        () =>
          stores.driver.run(
            `INSERT INTO tasks (id, orgId, title, status, views) VALUES ('t1', 'acme', 'first', 'open', 0)`,
          ),
        { partition: ACME },
      )
    ).unwrap();
    await stores.driver.run(`UPDATE tasks SET views = views + 1 WHERE id = 't1'`);
    // a fold writing another peer's increment: the guard lets it by and files nothing
    await folding(stores.driver, () =>
      stores.driver.run(`UPDATE tasks SET views = views + 10 WHERE id = 't1'`),
    );
    await stores.driver.run(`UPDATE tasks SET views = views + 2 WHERE id = 't1'`);
    const meshed = sent.length;

    const running = (await startCapture({ engine, source, mappings })).unwrap();
    await eventually(() => sent.length > meshed, "the outside writes");
    running.stop();
    (await running.done).unwrap();

    expect(patchesAfter(sent, meshed)).toEqual([{ views: { "+": 3 } }]);
  });

  test("an outside update to a row the mesh has not placed yet still lands in the row's instance", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const { stores, engine, sent } = await authority(driver);
    await stores.driver.run(
      `INSERT INTO tasks (id, orgId, title, status) VALUES ('t2', 'acme', 'from outside', 'open')`,
    );
    // the update commits after the first sweep claimed the insert and before its fold placed the
    // row, so it is filed with no `_partition` and carries only `status`
    let raced = false;
    const racing: SqlDriver = {
      ...stores.driver,
      run: async (sql, params) => {
        await stores.driver.run(sql, params);
        if (raced || !sql.includes("SET sweep")) return;
        raced = true;
        await stores.driver.run(`UPDATE tasks SET status = 'done' WHERE id = 't2'`);
      },
    };
    const source = stagedChangeSource({ name: "staged", driver: racing, tables, every: EVERY });
    const running = (await startCapture({ engine, source, mappings })).unwrap();
    await eventually(() => row(engine, "t2")?.["status"] === "done", "the raced update");
    running.stop();
    (await running.done).unwrap();

    expect(
      sent.flatMap((event) =>
        event.changes
          .filter((change) => change.table === TASKS)
          .map((change) => `${String(event.partition)} ${change.kind} ${change.key}`),
      ),
    ).toEqual(["org:acme insert t2", "org:acme update t2"]);
    expect(await tableRows(stores.driver)).toEqual(["t2 from outside done org:acme"]);
  });

  test("a restart sweeps what was written while stopped, and nothing already in the log", async () => {
    const driver = await openPair(":memory:", schemaName(tables));
    const { stores, engine, sent, source } = await authority(driver);
    await stores.driver.run(
      `INSERT INTO tasks (id, orgId, title, status) VALUES ('t1', 'acme', 'one', 'open')`,
    );
    const first = (await startCapture({ engine, source, mappings })).unwrap();
    await eventually(() => row(engine, "t1") !== undefined, "the first write");
    first.stop();
    expect((await first.done).unwrap().transactions).toBe(1);
    const before = sent.length;

    await stores.driver.run(`UPDATE tasks SET title = 'uno' WHERE id = 't1'`);
    await stores.driver.run(`DELETE FROM tasks WHERE id = 't1'`);
    await stores.driver.run(
      `INSERT INTO tasks (id, orgId, title, status) VALUES ('t2', 'acme', 'two', 'open')`,
    );

    const again = stagedChangeSource({
      name: "staged",
      driver: stores.driver,
      tables,
      every: EVERY,
    });
    const second = (await startCapture({ engine, source: again, mappings })).unwrap();
    await eventually(() => row(engine, "t2") !== undefined, "the writes made while stopped");
    expect(row(engine, "t1")).toBeUndefined();
    second.stop();
    // one sweep of the three writes, then its watermark: the first run's insert is not sent again
    expect((await second.done).unwrap().transactions).toBe(1);
    expect(
      sent
        .slice(before)
        .flatMap((event) => event.changes.map((c) => `${c.kind} ${c.table} ${c.key}`)),
    ).toEqual(["delete tasks t1", "insert tasks t2", "insert _cdc staged"]);
  });
});
