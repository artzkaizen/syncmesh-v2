import type { Engine } from "@syncmesh/engine";
import type { PartitionKey, TableName } from "@syncmesh/kernel";
import type { SqlDriver, Stores } from "@syncmesh/storage";

import { PGlite } from "@electric-sql/pglite";
import { interestText, openEngine } from "@syncmesh/engine";
import { createHlcClock, parsePeerId } from "@syncmesh/kernel";
import { pgliteDriver, postgresDriver } from "@syncmesh/postgres";
import { Result } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores, schemaName } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CHANGES_PER_EVENT, TABLES, tenant } from "./tenant.js";

/**
 * One tenant, end to end, on one backend: fold it into an authority, read it back through SQL,
 * reboot the authority, join a device scoped to a few teams, take it offline while the tenant
 * moves on, catch it up, and check the two agree.
 *
 * Every phase is timed with its memory before, after and at peak, and the results file is
 * rewritten after each one, so a run the kernel or the OOM killer stops part-way still says how
 * far it got. A phase that fails is a row in the results, not an exception: the run carries on
 * with what exists, because the phases after a slow fold are still worth measuring.
 */

export type Backend = "sqlite" | "pglite" | "postgres";

export interface TenantOptions {
  readonly backend: Backend;
  /** Rows to insert into the tenant before anything else is measured. */
  readonly rows: number;
  readonly partitions: number;
  /** Teams the joining device belongs to. */
  readonly scoped: number;
  /** Rows the tenant moves by while the device is offline, as a share of `rows`. */
  readonly drift: number;
  /**
   * Wall-clock budget for the fold: still going at the deadline, it stops and says how far it got,
   * and every later phase runs on what was loaded. Those are bounded by the rows, not the budget.
   */
  readonly budget: Temporal.Duration;
  readonly dir: string;
  /** Where the results JSON is rewritten after every phase. */
  readonly out?: string;
  /** `postgres` only: a throwaway database. Its `syncmesh` schema and the five tables are dropped first. */
  readonly url?: string;
  readonly seed?: number;
}

export interface Phase {
  readonly name: string;
  /** `running` only in a file saved mid-phase — what a run killed by the OOM killer leaves behind. */
  readonly status: "ok" | "failed" | "abandoned" | "skipped" | "running";
  readonly ms: number;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly peakRssMb: number;
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

export interface TenantResults {
  readonly backend: Backend;
  readonly target: number;
  readonly loaded: number;
  readonly events: number;
  readonly partitions: number;
  readonly startedAt: string;
  readonly runtime: string;
  readonly phases: readonly Phase[];
  /** Every invariant the run checked, true when it held. */
  readonly invariants: Readonly<Record<string, boolean>>;
}

const MB = 1024 * 1024;
const BATCH_EVENTS = 500;
const JOIN_PAGE = 2_000;
const AUTHORITY = parsePeerId("f".repeat(64)).unwrap();
const DEVICE = parsePeerId("e".repeat(64)).unwrap();
const SCHEMA = schemaName(TABLES);

// SAFETY: the five names `tenant.ts` declares, read back off its own table definitions
const tableName = (value: string) => value as TableName;

const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });

interface Opened {
  readonly driver: SqlDriver;
  readonly size: () => Promise<number>;
  readonly close: () => Promise<void>;
}

const filesBytes = (dir: string, prefix: string) =>
  readdirSync(dir)
    .filter((file) => file.startsWith(prefix))
    .reduce((total, file) => total + statSync(join(dir, file)).size, 0);

const pgSize = async (driver: SqlDriver) =>
  Number((await driver.all(`SELECT pg_database_size(current_database())`, []))[0]?.[0] ?? 0);

async function openBackend(
  options: TenantOptions,
  backend: Backend,
  name: string,
): Promise<Opened> {
  if (backend === "sqlite") {
    const driver = bunSqliteDriver(join(options.dir, `${name}.db`), SCHEMA);
    return {
      driver,
      size: () => Promise.resolve(filesBytes(options.dir, `${name}.db`)),
      close: async () => driver.close?.(),
    };
  }
  if (backend === "pglite") {
    const db = await PGlite.create(join(options.dir, name));
    const driver = pgliteDriver(db);
    return { driver, size: () => pgSize(driver), close: () => db.close() };
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(options.url ?? "", { max: 4, onnotice: (notice) => console.log(notice) });
  const driver = postgresDriver(sql);
  return { driver, size: () => pgSize(driver), close: () => sql.end() };
}

/** Clears what an earlier run left in the throwaway database. */
async function resetPostgres(options: TenantOptions): Promise<void> {
  const opened = await openBackend(options, "postgres", "reset");
  await opened.driver.run(`DROP SCHEMA IF EXISTS syncmesh CASCADE`, []);
  for (const x of TABLES) await opened.driver.run(`DROP TABLE IF EXISTS ${x.name} CASCADE`, []);
  await opened.close();
}

const engineOn = async (opened: Opened, peerId: typeof AUTHORITY) => {
  const stores = (await openStores(opened.driver, { tables: TABLES })).unwrap();
  const engine = (
    await openEngine({
      peerId,
      clock: clock(),
      store: stores.events,
      stateStore: stores.state,
      atomic: stores.atomic,
    })
  ).unwrap();
  return { stores, engine };
};

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;

/** Runs the tenant and returns what it measured; the same object is in `options.out` after every phase. */
export async function measureTenant(options: TenantOptions): Promise<TenantResults> {
  const started = Temporal.Now.instant();
  const deadline = started.add(options.budget);
  const generator = tenant({ partitions: options.partitions, seed: options.seed ?? 7 });
  const phases: Phase[] = [];
  const invariants: Record<string, boolean> = {};
  let events = 0;
  /** Rows the fold phase got in: the tenant's size for everything after it. */
  let loaded = 0;

  const results = (): TenantResults => ({
    backend: options.backend,
    target: options.rows,
    loaded,
    events,
    partitions: options.partitions,
    startedAt: started.toString(),
    runtime: `bun ${Bun.version} ${process.platform}-${process.arch}`,
    phases,
    invariants,
  });
  const save = () => {
    if (options.out !== undefined) writeFileSync(options.out, JSON.stringify(results(), null, 2));
  };
  const overBudget = () => Temporal.Instant.compare(Temporal.Now.instant(), deadline) >= 0;

  /** Runs one phase, timed and sampled; its failure is a row, never a throw. */
  const phase = async (
    name: string,
    fn: (
      detail: Record<string, number | string | boolean>,
    ) => Promise<Exclude<Phase["status"], "running"> | void>,
  ): Promise<boolean> => {
    const detail: Record<string, number | string | boolean> = {};
    const index = phases.length;
    phases.push({ name, status: "running", ms: 0, rssMb: 0, heapMb: 0, peakRssMb: 0, detail });
    let peak = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 50);
    const from = Bun.nanoseconds();
    const ran = await Result.tryPromise({ try: () => fn(detail), catch: (cause) => cause });
    clearInterval(sampler);
    const memory = process.memoryUsage();
    const status = ran.isOk() ? (ran.value ?? "ok") : "failed";
    if (ran.isErr())
      detail.error = ran.error instanceof Error ? ran.error.message : JSON.stringify(ran.error);
    phases[index] = {
      name,
      status,
      ms: Math.round((Bun.nanoseconds() - from) / 1e6),
      rssMb: Math.round(memory.rss / MB),
      heapMb: Math.round(memory.heapUsed / MB),
      peakRssMb: Math.round(Math.max(peak, memory.rss) / MB),
      detail,
    };
    save();
    console.log(`  ${name}: ${status} in ${phases.at(-1)?.ms} ms ${JSON.stringify(detail)}`);
    return status === "ok";
  };

  if (options.backend === "postgres") await resetPostgres(options);
  let authorityStore = await openBackend(options, options.backend, "authority");
  let authority: { stores: Stores; engine: Engine } | undefined;

  await phase("open authority", async () => {
    authority = await engineOn(authorityStore, AUTHORITY);
  });

  // fold: the tenant arrives at the authority as devices' batches, through the receive path
  await phase("fold", async (detail) => {
    if (authority === undefined) return "skipped";
    const engine = authority.engine;
    const deciles: number[] = [];
    let lastMark = Bun.nanoseconds();
    let lastRows = 0;
    let nextDecile = options.rows / 10;
    // and on the clock: a fold the budget stops before its first tenth still leaves a curve
    const curve: string[] = [];
    let nextSample = Bun.nanoseconds() + 30e9;
    const foldStarted = Bun.nanoseconds();
    while (generator.rowsInserted() < options.rows) {
      if (overBudget()) {
        loaded = generator.rowsInserted();
        detail.stoppedAt = loaded;
        return "abandoned";
      }
      const left = Math.ceil((options.rows - generator.rowsInserted()) / CHANGES_PER_EVENT);
      const batch = generator.events(Math.min(BATCH_EVENTS, left), "insert");
      (await engine.receiveBatch(batch)).unwrap();
      events += batch.length;
      if (Bun.nanoseconds() >= nextSample) {
        const seconds = Math.round((Bun.nanoseconds() - foldStarted) / 1e9);
        const rss = Math.round(process.memoryUsage().rss / MB);
        curve.push(`${generator.rowsInserted()}@${seconds}s/${rss}MB`);
        detail.curve = curve.join(",");
        nextSample += 30e9;
        save();
      }
      if (generator.rowsInserted() >= nextDecile) {
        const now = Bun.nanoseconds();
        // rows per second over this tenth of the load: a flat line is linear, a falling one is not
        const rows = generator.rowsInserted() - lastRows;
        deciles.push(Math.round((rows / (now - lastMark)) * 1e9));
        lastMark = now;
        lastRows = generator.rowsInserted();
        detail.deciles = deciles.join(",");
        while (nextDecile <= lastRows) nextDecile += options.rows / 10;
      }
    }
    loaded = generator.rowsInserted();
    detail.rowsPerSecFirstTenth = deciles[0] ?? 0;
    detail.rowsPerSecLastTenth = deciles.at(-1) ?? 0;
    detail.deciles = deciles.join(",");
  });

  await phase("storage size", async (detail) => {
    detail.authorityBytes = await authorityStore.size();
    detail.bytesPerRow = Math.round(detail.authorityBytes / Math.max(1, generator.rowsInserted()));
  });

  // what the app's SQL sees: the materialised tables, no engine in the way
  await phase("query latency", async (detail) => {
    const { driver } = authorityStore;
    const mark = (n: number) => (driver.dialect === "postgres" ? `$${n}` : "?");
    const random = Math.random;
    const team = () => `workspace:team${Math.floor(random() * options.partitions)}`;
    const queries = {
      point: async () => {
        const at = Math.floor(random() * options.partitions);
        const n = 1 + Math.floor(random() * Math.max(1, generator.inserted("issues", at)));
        await driver.all(`SELECT * FROM issues WHERE id = ${mark(1)}`, [`issues-${at}-${n}`]);
      },
      inbox: () =>
        driver.all(
          `SELECT * FROM messages WHERE _partition = ${mark(1)} ORDER BY created_at DESC LIMIT 50`,
          [team()],
        ),
      board: () =>
        driver.all(
          `SELECT status, COUNT(*) FROM issues WHERE _partition = ${mark(1)} GROUP BY status`,
          [team()],
        ),
      pipeline: () =>
        driver.all(
          `SELECT stage, SUM(amount) FROM deals WHERE _partition = ${mark(1)} AND won = ${mark(2)} GROUP BY stage`,
          [team(), driver.dialect === "postgres" ? true : 1],
        ),
    };
    for (const [label, run] of Object.entries(queries)) {
      const samples: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const from = Bun.nanoseconds();
        await run();
        samples.push((Bun.nanoseconds() - from) / 1e6);
      }
      samples.sort((a, b) => a - b);
      detail[`${label}P50Ms`] = Number(percentile(samples, 50).toFixed(2));
      detail[`${label}P99Ms`] = Number(percentile(samples, 99).toFixed(2));
    }
  });

  await phase("boot (reopen persisted state)", async (detail) => {
    await authorityStore.close();
    // a restart: the engine that folded the tenant is gone before the next one opens
    authority = undefined;
    Bun.gc(true);
    authorityStore = await openBackend(options, options.backend, "authority");
    authority = await engineOn(authorityStore, AUTHORITY);
    detail.rowsInMemory = TABLES.reduce(
      (n, x) => n + (authority?.engine.state().get(tableName(x.name))?.size ?? 0),
      0,
    );
  });

  // the device: a phone on a few teams, always SQLite
  const mine: readonly PartitionKey[] = generator.partitions.slice(0, options.scoped);
  const interest = { partitions: mine };
  const deviceStore = await openBackend(options, "sqlite", "device");
  let device: { stores: Stores; engine: Engine } | undefined;

  /**
   * A filtered catch-up as the relay session runs one (D23): the pages, then the coverage they
   * stand for, scoped to what was asked — or the device's cursors stop at the first event the
   * filter left out and every later catch-up re-sends from there.
   */
  const deliver = async (from: Engine, to: Engine) => {
    const covered = (await from.cursors()).unwrap();
    const owed = (await from.eventsSince((await to.cursors()).unwrap(), interest)).unwrap();
    for (let at = 0; at < owed.length; at += JOIN_PAGE)
      (await to.receiveBatch(owed.slice(at, at + JOIN_PAGE))).unwrap();
    to.adoptCoverage({ synced: covered, local: new Map(), scope: interestText(interest) });
    return owed.length;
  };

  await phase(`initial join (${options.scoped} of ${options.partitions} teams)`, async (detail) => {
    if (authority === undefined) return "skipped";
    device = await engineOn(deviceStore, DEVICE);
    detail.events = await deliver(authority.engine, device.engine);
    detail.deviceBytes = await deviceStore.size();
  });

  await phase("catch-up after offline drift", async (detail) => {
    if (authority === undefined || device === undefined) return "skipped";
    const drift = Math.max(1, Math.ceil((options.rows * options.drift) / CHANGES_PER_EVENT));
    for (let at = 0; at < drift; at += BATCH_EVENTS) {
      const batch = generator.events(Math.min(BATCH_EVENTS, drift - at), "mixed");
      (await authority.engine.receiveBatch(batch)).unwrap();
      events += batch.length;
    }
    const from = Bun.nanoseconds();
    detail.driftEvents = drift;
    detail.events = await deliver(authority.engine, device.engine);
    detail.catchUpMs = Math.round((Bun.nanoseconds() - from) / 1e6);
  });

  await phase("convergence", async (detail) => {
    if (authority === undefined || device === undefined) return "skipped";
    const theirs = authority.engine.digest(interest);
    const ours = device.engine.digest(interest);
    const agree = TABLES.every(
      (x) => `${theirs.get(tableName(x.name))}` === `${ours.get(tableName(x.name))}`,
    );
    invariants["device digest equals authority digest over its teams"] = agree;
    const rows = await deviceStore.driver.all(`SELECT COUNT(*) FROM issues`, []);
    const engineRows = device.engine.state().get(tableName("issues"))?.size ?? 0;
    invariants["device issues table matches its engine state"] =
      Number(rows[0]?.[0]) === engineRows;
    detail.agree = agree;
    return agree ? "ok" : "failed";
  });

  await authorityStore.close();
  await deviceStore.close();
  save();
  return results();
}
