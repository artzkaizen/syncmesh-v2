import type { ChangeMessage, ChangeStream } from "@syncmesh/cdc";
import type { SuiteCase } from "@syncmesh/engine";

import { parseWatermark } from "@syncmesh/cdc";
import { equal } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { captureChanges, installCapture } from "../capture.js";
import { installGuard } from "../guard.js";
import { stagedChangeSource } from "../staged.js";
import { COUNTERS as counters, JOBS as jobs, asFold, sqlText } from "./fixtures.js";

/**
 * Staged tables (RFC-0025, class c): a write made outside the mesh is filed in the staged-changes
 * queue instead of refused, and `stagedChangeSource` hands the queue to the CDC bridge one sweep
 * at a time — each the net effect of every write it took, numbered so an acked sweep is never
 * sent again and an unacked one always is.
 */

const outcome = async (fn: () => Promise<void>) =>
  (await Result.tryPromise({ try: fn, catch: (cause) => String(cause) })).match({
    ok: () => "applied",
    err: (message) => (message.includes("outside a captured write") ? "refused" : message),
  });

const queued = async (driver: SqlDriver) =>
  (await driver.all(`SELECT tbl, op, key FROM ${stagedTable(driver)} ORDER BY seq`)).map((row) =>
    row.map(String).join(" "),
  );

const stagedTable = (driver: SqlDriver) =>
  driver.dialect === "postgres" ? "syncmesh.staged" : "syncmesh_staged";

/** One message as a line: the op, the table, the key, and the row's cells by name. */
const line = (message: ChangeMessage): string => {
  if (message.t === "begin") return "begin";
  if (message.t === "commit") return `commit ${message.watermark}`;
  if (message.t === "insert" || message.t === "update") {
    const row = message.t === "insert" ? message.row : message.after;
    const cells = Object.entries(row)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
    const key = message.t === "update" ? ` ${message.key}` : "";
    return `${message.t} ${message.table}${key} ${cells.join(" ")}`;
  }
  if (message.t === "delete") return `delete ${message.table} ${message.key}`;
  return message.t;
};

/** Every message of the stream's next transaction, `begin` through `commit`. */
const nextTransaction = async (
  messages: AsyncIterator<ChangeMessage>,
): Promise<readonly string[]> => {
  const lines: string[] = [];
  for (;;) {
    const next = await messages.next();
    if (next.done === true) return [...lines, "ended"];
    lines.push(line(next.value));
    if (next.value.t === "commit") return lines;
  }
};

const EVERY = Temporal.Duration.from({ milliseconds: 5 });

const opened = (driver: SqlDriver) =>
  stagedChangeSource({ name: "staged", driver, tables: [jobs, counters], every: EVERY });

const reader = (stream: ChangeStream) => stream.changes[Symbol.asyncIterator]();

/** The watermark of the `n`th sweep, and its `commit` line. */
const mark = (n: number) => parseWatermark(String(n).padStart(20, "0")).unwrap();
const watermark = (n: number) => `commit ${mark(n)}`;

export const stagedCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "stage: an unarmed write to a staged table is filed, not refused; a captured write, the fold's and an unstaged table's are not",
    run: async () => {
      const driver = await openDriver("stage-files");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs, counters], { strict: { stage: ["jobs"] } })).unwrap();
      await asFold(driver, () =>
        driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'kept', 1, ${L.F})`),
      );
      equal(await queued(driver), [], "the fold's write is not filed");
      const raw = `INSERT INTO jobs (id, title, rank, done) VALUES ('j2', 'outside', 2, ${L.F})`;
      equal(await outcome(() => driver.run(raw)), "applied", "an outside insert");
      equal(
        await outcome(() => driver.run(`UPDATE jobs SET title = 'moved' WHERE id = 'j1'`)),
        "applied",
        "an outside update",
      );
      equal(
        await outcome(() => driver.run(`DELETE FROM jobs WHERE id = 'j2'`)),
        "applied",
        "an outside delete",
      );
      const captured = await captureChanges(driver, [jobs], () =>
        driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j3', 'mesh', 3, ${L.F})`),
      );
      equal(captured.unwrap().length, 1, "a captured write is captured");
      equal(
        await queued(driver),
        ["jobs insert j2", "jobs update j1", "jobs delete j2"],
        "the outside writes, and only those",
      );
      equal(
        await outcome(() => driver.run(`INSERT INTO counters (id, n) VALUES (1, 1)`)),
        "refused",
        "a table not staged is still refused",
      );
      if (driver.dialect === "postgres") {
        equal(await outcome(() => driver.run(`TRUNCATE jobs`)), "refused", "a TRUNCATE");
      }
    },
  },
  {
    name: "stage: switching a table between refused, staged and off replaces its triggers",
    run: async () => {
      const driver = await openDriver("stage-switch");
      const L = sqlText(driver);
      const insert = (id: string) =>
        outcome(() =>
          driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('${id}', 'x', 1, ${L.F})`),
        );
      (await installCapture(driver, [jobs])).unwrap();
      equal(await insert("a"), "refused", "refused by default");
      (await installGuard(driver, [jobs], { stage: ["jobs"] })).unwrap();
      equal(await insert("b"), "applied", "staged");
      (await installGuard(driver, [jobs], { stage: ["jobs"] })).unwrap();
      equal(await insert("c"), "applied", "staged again, idempotent");
      (await installGuard(driver, [jobs], true)).unwrap();
      equal(await insert("d"), "refused", "refused again");
      (await installGuard(driver, [jobs], { stage: ["jobs"], except: ["jobs"] })).unwrap();
      equal(await insert("e"), "applied", "named in both: staged");
      (await installGuard(driver, [jobs], false)).unwrap();
      equal(await insert("f"), "applied", "off");
      equal(
        await queued(driver),
        ["jobs insert b", "jobs insert c", "jobs insert e"],
        "filed only while staged",
      );
      // the schema drops the table: no setting reaches it, so its staging goes with it
      (await installGuard(driver, [jobs], { stage: ["jobs"] })).unwrap();
      (await installCapture(driver, [counters])).unwrap();
      equal(await insert("g"), "applied", "out of the schema");
      equal((await queued(driver)).length, 3, "and no longer filed");
    },
  },
  {
    name: "stage: a sweep is one transaction of each row's net effect; an unacked sweep is sent again, an acked one never",
    run: async () => {
      const driver = await openDriver("stage-sweeps");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs, counters], { strict: { stage: ["jobs"] } })).unwrap();
      await asFold(driver, async () => {
        await driver.run(
          `INSERT INTO jobs (id, title, rank, done, "_partition") VALUES ('j1', 'kept', 1, ${L.F}, 'org:acme')`,
        );
      });
      await driver.run(`UPDATE jobs SET title = 'outside' WHERE id = 'j1'`);
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j2', 'new', 2, ${L.T})`);
      await driver.run(`UPDATE jobs SET rank = 5 WHERE id = 'j2'`);
      await driver.run(`UPDATE jobs SET rank = 1 WHERE id = 'j1'`);

      const source = opened(driver);
      const first = await source.start({ after: null });
      const sweepOne = [
        "begin",
        `update jobs j1 _partition="org:acme" title="outside"`,
        `insert jobs _partition=null done=true dueAt=null hours=null id="j2" meta=null photo=null rank=5 title="new"`,
        watermark(1),
      ];
      equal(await nextTransaction(reader(first)), sweepOne, "the first sweep");
      first.stop();

      // never acked: the next stream from the same position sends the same sweep
      const again = await source.start({ after: null });
      const messages = reader(again);
      equal(await nextTransaction(messages), sweepOne, "sent again");
      again.ack(mark(1));
      await driver.run(`DELETE FROM jobs WHERE id = 'j2'`);
      source.sweep();
      equal(
        await nextTransaction(messages),
        ["begin", "delete jobs j2", watermark(2)],
        "the next sweep, numbered after it",
      );
      equal((await source.pending()).unwrap(), 1, "the acked sweep's rows are gone");
      again.stop();

      // resumed after the second: nothing is sent until something new is written
      const resumed = await source.start({ after: mark(2) });
      const later = reader(resumed);
      await driver.run(`UPDATE jobs SET done = ${L.T} WHERE id = 'j1'`);
      source.sweep();
      equal(
        await nextTransaction(later),
        ["begin", `update jobs j1 _partition="org:acme" done=true`, watermark(3)],
        "only what came after",
      );
      resumed.stop();
    },
  },
];
