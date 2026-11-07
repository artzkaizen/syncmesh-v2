import type { ChangeMessage } from "@syncmesh/cdc";

import { startCapture, storedWatermark } from "@syncmesh/cdc";
import { Temporal } from "@syncmesh/temporal";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import type { SlotStatus } from "../index.js";

import { PartialKeyChange, SlotLost, lsnWatermark, parseLsn, parseLsnWatermark } from "../index.js";
import {
  ACME,
  POSTGRES_URL,
  authorityEngine,
  commits,
  eventually,
  iterate,
  mappingsFor,
  schemaFor,
  scratch,
  settle,
  sql,
  take,
  tracked,
} from "./replication-fixtures.js";

// a slot, a walsender and a reconnect each take real time on a real server
setDefaultTimeout(30_000);

const db = sql();
afterEach(settle);
afterAll(() => db.end());

const confirmed = async (source: { status: () => Promise<{ unwrap(): SlotStatus | null }> }) =>
  (await source.status()).unwrap()?.confirmed ?? null;

const commitOf = (seen: readonly ChangeMessage[]) => {
  const commit = seen.filter((m) => m.t === "commit").at(-1);
  if (commit?.t !== "commit") throw new Error("no commit");
  return parseLsnWatermark(commit.watermark).unwrap();
};

const changesOnly = (seen: readonly ChangeMessage[]) =>
  seen.filter((m) => m.t !== "begin" && m.t !== "commit");

describe.skipIf(POSTGRES_URL === undefined)("Postgres logical replication", () => {
  test("insert, update, delete and truncate arrive transaction-framed, keyed by the identity", async () => {
    const { table, source, cleanup } = await scratch(db);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    await db.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', 'one'), ('t2', 'acme', 'two')`);
      await tx.unsafe(`UPDATE ${table} SET title = 'uno' WHERE id = 't1'`);
      await tx.unsafe(`DELETE FROM ${table} WHERE id = 't2'`);
    });
    await db.unsafe(`TRUNCATE ${table}`);
    const seen = await take(changes, commits(2), "two transactions");
    expect(seen.map((m) => m.t)).toEqual([
      "begin",
      "insert",
      "insert",
      "update",
      "delete",
      "commit",
      "begin",
      "truncate",
      "commit",
    ]);
    expect(seen[1]).toEqual({
      t: "insert",
      table,
      row: { id: "t1", org_id: "acme", title: "one" },
    });
    expect(seen[3]).toEqual({
      t: "update",
      table,
      key: "t1",
      after: { id: "t1", org_id: "acme", title: "uno" },
    });
    expect(seen[4]).toEqual({ t: "delete", table, key: "t2" });
    stream.stop();
    await cleanup();
  });

  test("nothing is acked before the bridge acks it, and never past what was decoded", async () => {
    const { table, source, cleanup } = await scratch(db);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    const unpublished = `${table}_private`;
    await db.unsafe(`CREATE TABLE ${unpublished} (id int)`);

    // an ack for a position nothing delivered: there is nothing below it to release
    stream.ack(lsnWatermark(parseLsn("FFFF/0").unwrap()));
    await db.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', 'held')`);
    const seen = await take(changes, commits(1), "the transaction");
    const end = commitOf(seen);

    // decoded and delivered, not acked: unrelated WAL and keepalives go by, the slot stays
    // behind the transaction however many status updates are sent (one every 50ms here)
    for (let i = 0; i < 5; i += 1) await db.unsafe(`INSERT INTO ${unpublished} VALUES (${i})`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const held = await confirmed(source);
    expect(held).not.toBeNull();
    expect(held! < end).toBe(true);

    // the bridge says the events are durable: now, and only now, the slot moves past it
    stream.ack(lsnWatermark(end));
    await eventually(async () => ((await confirmed(source)) ?? 0n) >= end, "the ack to land");

    stream.stop();
    await db.unsafe(`DROP TABLE ${unpublished}`);
    await cleanup();
  });

  test("a consumer that dies mid-transaction gets the whole transaction again", async () => {
    const { table, options, source, cleanup } = await scratch(db);
    const first = await source.start({ after: null });
    const changes = iterate(first);
    await db.unsafe(
      `INSERT INTO ${table} VALUES ('a', 'acme', '1'), ('b', 'acme', '2'), ('c', 'acme', '3')`,
    );
    await take(changes, (seen) => seen.some((m) => m.t === "insert"), "the first row");
    first.stop(); // the process dies: begin and one insert seen, nothing acked

    const restarted = tracked(options); // a new process, the same slot
    const second = await restarted.start({ after: null });
    const replay = await take(iterate(second), commits(1), "the replay");
    expect(replay.map((m) => m.t)).toEqual(["begin", "insert", "insert", "insert", "commit"]);
    second.stop();
    await cleanup();
  });

  test("a connection cut mid-transaction reconnects and resends it from its begin", async () => {
    const { table, options, source, cleanup } = await scratch(db);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    // far more rows than the source buffers before it pushes back, so the transaction cannot
    // have arrived whole when the connection is cut
    const rows = 50_000;
    await db.unsafe(
      `INSERT INTO ${table} SELECT g::text, 'acme', 'x' FROM generate_series(1, ${rows}) g`,
    );
    const before = await take(
      changes,
      (seen) => seen.some((m) => m.t === "insert"),
      "the first row",
    );
    await db.unsafe(
      `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = $1`,
      [options.slot],
    );
    const after = await take(changes, commits(1), "the resent transaction");
    const seen = [...before, ...after];
    // the port's rule: a begin discards whatever came after the last commit
    const resent = seen.slice(seen.map((m) => m.t).lastIndexOf("begin"));
    expect(seen.filter((m) => m.t === "begin").length).toBeGreaterThan(1);
    expect(resent.filter((m) => m.t === "insert")).toHaveLength(rows);
    expect(resent.at(-1)?.t).toBe("commit");
    expect(seen.filter((m) => m.t === "commit")).toHaveLength(1);
    stream.stop();
    await cleanup();
  });

  test("a restart from a checkpoint neither skips nor repeats", async () => {
    const { table, options, source, cleanup } = await scratch(db);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    await db.unsafe(`INSERT INTO ${table} VALUES ('a', 'acme', '1')`);
    await db.unsafe(`INSERT INTO ${table} VALUES ('b', 'acme', '2')`);
    const seen = await take(changes, commits(2), "two transactions");
    const firstCommit = seen.find((m) => m.t === "commit");
    if (firstCommit?.t !== "commit") throw new Error("no commit");
    stream.ack(firstCommit.watermark); // the second is delivered, never acked
    stream.stop();
    await db.unsafe(`INSERT INTO ${table} VALUES ('c', 'acme', '3')`);

    const restarted = tracked(options);
    const resumed = await restarted.start({ after: firstCommit.watermark });
    const replay = await take(iterate(resumed), commits(2), "b again, then c");
    expect(changesOnly(replay).map((m) => (m.t === "insert" ? m.row.id : m.t))).toEqual(["b", "c"]);
    resumed.stop();
    await cleanup();
  });

  test("REPLICA IDENTITY FULL: the old row keys a delete and fills an unchanged TOAST value", async () => {
    const { table, source, cleanup } = await scratch(
      db,
      "id text PRIMARY KEY, org_id text, body text",
    );
    await db.unsafe(`ALTER TABLE ${table} ALTER COLUMN body SET STORAGE EXTERNAL`);
    const body = "x".repeat(20_000); // out of line: Postgres does not resend it on an update
    await db.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', $1)`, [body]);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);

    await db.unsafe(`UPDATE ${table} SET org_id = 'globex' WHERE id = 't1'`);
    const plain = await take(changes, commits(1), "the default-identity update");
    expect(plain[1]).toEqual({
      t: "update",
      table,
      key: "t1",
      after: { id: "t1", org_id: "globex" },
    });

    await db.unsafe(`ALTER TABLE ${table} REPLICA IDENTITY FULL`);
    await db.unsafe(`UPDATE ${table} SET org_id = 'acme' WHERE id = 't1'`);
    await db.unsafe(`UPDATE ${table} SET id = 't2' WHERE id = 't1'`);
    await db.unsafe(`DELETE FROM ${table} WHERE id = 't2'`);
    const full = changesOnly(await take(changes, commits(3), "the full-identity changes"));
    expect(full[0]).toEqual({
      t: "update",
      table,
      key: "t1",
      after: { id: "t1", org_id: "acme", body },
    });
    // a key change is a different row: one goes, the other arrives
    expect(full.slice(1, 3)).toEqual([
      { t: "delete", table, key: "t1" },
      { t: "insert", table, row: { id: "t2", org_id: "acme", body } },
    ]);
    expect(full[3]).toEqual({ t: "delete", table, key: "t2" });
    stream.stop();
    await cleanup();
  });

  test("REPLICA IDENTITY DEFAULT: a key change that did not resend a TOAST value ends the stream", async () => {
    const { table, source, cleanup } = await scratch(
      db,
      "id text PRIMARY KEY, org_id text, body text",
    );
    await db.unsafe(`ALTER TABLE ${table} ALTER COLUMN body SET STORAGE EXTERNAL`);
    const body = "x".repeat(20_000);
    await db.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', $1), ('s1', 'acme', 'short')`, [
      body,
    ]);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);

    // an inline value is always sent: the new row arrives whole
    await db.unsafe(`UPDATE ${table} SET id = 's2' WHERE id = 's1'`);
    const inline = changesOnly(await take(changes, commits(1), "the inline key change"));
    expect(inline).toEqual([
      { t: "delete", table, key: "s1" },
      { t: "insert", table, row: { id: "s2", org_id: "acme", body: "short" } },
    ]);

    // an out-of-line value is not, and the old row holds only the key: an insert without it
    // would lose it for good, so the stream fails instead
    await db.unsafe(`UPDATE ${table} SET id = 't2' WHERE id = 't1'`);
    const failed = await take(changes, commits(1), "the TOAST key change").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failed).toBeInstanceOf(PartialKeyChange);
    expect(failed).toMatchObject({ table, columns: ["body"] });
    await cleanup();
  });

  test("a resume from a stored position whose slot is gone is SlotLost, not a silent gap", async () => {
    const { table, options, source, cleanup } = await scratch(db);
    const first = await source.start({ after: null });
    await db.unsafe(`INSERT INTO ${table} VALUES ('a', 'acme', '1')`);
    const end = lsnWatermark(commitOf(await take(iterate(first), commits(1), "a")));
    first.ack(end);
    first.stop();
    expect((await source.drop()).unwrap()).toBe(true);
    await db.unsafe(`INSERT INTO ${table} VALUES ('lost', 'acme', '2')`);

    const resumed = await tracked(options)
      .start({ after: end })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(resumed).toBeInstanceOf(SlotLost);
    // refused without making a slot, so nothing pretends to hold the gap
    expect((await source.status()).unwrap()).toBeNull();
    await cleanup();
  });

  test("a table that changes shape mid-stream raises the schema alarm", async () => {
    const { table, source, cleanup } = await scratch(db);
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    await db.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', 'one')`);
    await take(changes, commits(1), "the first row");
    await db.unsafe(`ALTER TABLE ${table} ADD COLUMN due date`);
    await db.unsafe(`INSERT INTO ${table} VALUES ('t2', 'acme', 'two', '2026-11-07')`);
    const seen = await take(changes, (s) => s.some((m) => m.t === "schema"), "the alarm");
    expect(seen.find((m) => m.t === "schema")).toMatchObject({ t: "schema", table });
    stream.stop();
    await cleanup();
  });

  test("types read the same through the stream and the backfill", async () => {
    const columns =
      "id text PRIMARY KEY, n int4, big int8, ok bool, f float8, at timestamptz, raw bytea, doc jsonb, amount numeric";
    const { table, source, cleanup } = await scratch(db, columns);
    const stream = await source.start({ after: null });
    await db.unsafe(
      `INSERT INTO ${table} VALUES ('r', 7, 9007199254740991, true, 1.5, '2026-11-07 12:00:00.5+00', '\\x00ff', '{"a":1}', 1.10)`,
    );
    const streamed = await take(iterate(stream), commits(1), "the row");
    const rows = [];
    for await (const row of source.read.rows(table)) rows.push(row);
    const expected = {
      id: "r",
      n: 7,
      big: 9_007_199_254_740_991,
      ok: true,
      f: 1.5,
      at: Temporal.Instant.from("2026-11-07T12:00:00.5Z").epochMilliseconds,
      raw: Uint8Array.from([0, 255]),
      doc: { a: 1 },
      amount: "1.10",
    };
    expect(streamed[1]).toEqual({ t: "insert", table, row: expected });
    expect(rows).toEqual([expected]);
    stream.stop();
    await cleanup();
  });

  test("a backfill misses no row that an update moves behind where the read has reached", async () => {
    const { table, source, cleanup } = await scratch(
      db,
      "id text PRIMARY KEY, org_id text, title text) WITH (fillfactor = 100, autovacuum_enabled = false",
    );
    // full pages, ordered by key and position alike, so an update cannot stay on its own page
    await db.unsafe(
      `INSERT INTO ${table} SELECT 'r' || lpad(g::text, 4, '0'), 'acme', repeat('x', 200)
         FROM generate_series(1, 1200) g`,
    );
    const block = async (id: string) =>
      Number(
        (await db.unsafe(`SELECT (ctid::text::point)[0] AS b FROM ${table} WHERE id = $1`, [id]))[0]
          ?.b,
      );
    const rows = source.read.rows(table)[Symbol.asyncIterator]();
    const first = await rows.next(); // one page read: the read is part-way through the table
    expect(first.done).toBe(false);

    // room on the first page, then an update far ahead of the read that lands in it
    await db.unsafe(`DELETE FROM ${table} WHERE id <= 'r0100'`);
    await db.unsafe(`VACUUM ${table}`);
    const was = await block("r1100");
    await db.unsafe(`UPDATE ${table} SET title = repeat('y', 400) WHERE id = 'r1100'`);
    expect(await block("r1100")).toBeLessThan(was);

    const ids = [first.value.id];
    for (let next = await rows.next(); next.done !== true; next = await rows.next()) {
      ids.push(next.value.id);
    }
    expect(ids).toContain("r1100");
    await cleanup();
  });

  test("the slot: created on first start, resumed after, busy while read, then dropped", async () => {
    const { options, source, cleanup } = await scratch(db);
    expect((await source.status()).unwrap()).toBeNull();
    const stream = await source.start({ after: null });
    await eventually(
      async () => (await source.status()).unwrap()?.active === true,
      "the walsender",
    );

    const rival = tracked({
      ...options,
      reconnect: { attempts: 0, delay: Temporal.Duration.from({ milliseconds: 1 }) },
    });
    expect(await rival.start({ after: null }).catch((cause: unknown) => cause)).toMatchObject({
      _tag: "SlotBusy",
    });
    expect((await rival.drop()).isErr()).toBe(true);

    stream.stop();
    expect((await source.drop()).unwrap()).toBe(true); // waits for its own stream to close
    expect((await source.status()).unwrap()).toBeNull();
    expect((await source.drop()).unwrap()).toBe(false);
    await cleanup();
  });

  test("a publication that does not exist stops the start", async () => {
    const { options, cleanup } = await scratch(db);
    const orphan = tracked({ ...options, publication: "absent_pub" });
    expect(await orphan.start({ after: null }).catch((cause: unknown) => cause)).toMatchObject({
      _tag: "PublicationMissing",
    });
    await cleanup();
  });

  test("a slot held behind by unacked work raises the lag alarm", async () => {
    const { table, options, cleanup } = await scratch(db);
    const alarms: SlotStatus[] = [];
    const source = tracked({
      ...options,
      lag: {
        bytes: 1,
        every: Temporal.Duration.from({ milliseconds: 50 }),
        alarm: (status) => void alarms.push(status),
      },
    });
    const stream = await source.start({ after: null });
    const changes = iterate(stream);
    await db.unsafe(
      `INSERT INTO ${table} SELECT g::text, 'acme', 'x' FROM generate_series(1, 200) g`,
    );
    await take(changes, commits(1), "the rows"); // delivered, never acked
    await eventually(() => alarms.length > 0, "the alarm");
    expect(alarms[0]?.lag).toBeGreaterThan(1);
    stream.stop();
    await cleanup();
  });
});

describe.skipIf(POSTGRES_URL === undefined)("through the bridge", () => {
  test("backfill, stream, stop, write while stopped, restart: the mesh ends where the table does", async () => {
    const { table, options, source, cleanup } = await scratch(db);
    const schema = schemaFor(table);
    const collection = schema.tables[table]!;
    const mappings = mappingsFor(table, schema);
    const engine = authorityEngine(schema);
    await db.unsafe(`INSERT INTO ${table} VALUES ('old', 'acme', 'before the slot')`);

    const first = (
      await startCapture({ engine, source, mappings, backfill: source.read })
    ).unwrap();
    await db.unsafe(`INSERT INTO ${table} VALUES ('t1', 'acme', 'one')`);
    await db.unsafe(`INSERT INTO ${table} VALUES ('t2', 'acme', 'two')`);
    await eventually(() => engine.rowsIn(collection.name, ACME).size === 3, "backfill and stream");
    first.stop();
    const firstReport = (await first.done).unwrap();
    expect(firstReport.transactions).toBe(2);
    const checkpoint = storedWatermark(engine, source.name);
    expect(checkpoint).toBe(firstReport.watermark);

    await db.unsafe(`UPDATE ${table} SET title = 'uno' WHERE id = 't1'`);
    await db.unsafe(`DELETE FROM ${table} WHERE id = 't2'`);
    await db.unsafe(`INSERT INTO ${table} VALUES ('t3', 'acme', 'three')`);

    const restarted = tracked(options);
    const second = (
      await startCapture({ engine, source: restarted, mappings, backfill: restarted.read })
    ).unwrap();
    await eventually(
      () =>
        engine.rowsIn(collection.name, ACME).size === 3 &&
        [...engine.rowsIn(collection.name, ACME).keys()].map(String).includes("t3"),
      "the writes made while stopped",
    );
    await eventually(async () => {
      const at = await restarted.status();
      const stored = storedWatermark(engine, restarted.name);
      return (
        stored !== null && (at.unwrap()?.confirmed ?? 0n) >= parseLsnWatermark(stored).unwrap()
      );
    }, "the slot to confirm the last applied transaction");
    second.stop();
    const report = (await second.done).unwrap();
    // exactly the three made while stopped: none of the first run's, no backfill again
    expect(report.transactions).toBe(3);

    const mesh = Object.fromEntries(
      [...engine.rowsIn(collection.name, ACME)].map(([key, row]) => [
        String(key),
        row.get(collection.columnNames.title),
      ]),
    );
    const rows = await db.unsafe(`SELECT id, title FROM ${table} ORDER BY id`);
    expect(mesh).toEqual(Object.fromEntries(rows.map((r) => [r.id, r.title])));
    await cleanup();
  });
});
