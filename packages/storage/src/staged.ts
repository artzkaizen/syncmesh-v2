import type {
  ChangeMessage,
  ChangeSource,
  ChangeStream,
  SourceRow,
  Watermark,
} from "@syncmesh/cdc";
import type { StoreFailure } from "@syncmesh/engine";
import type { Row } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Table } from "@syncmesh/schema";

import { parseWatermark } from "@syncmesh/cdc";
import { Temporal, durationMs } from "@syncmesh/temporal";

import type { StagedSql } from "./dialect.js";
import type { SqlDriver, SqlRow } from "./driver.js";

import { netChange } from "./capture.js";
import { driverDialect } from "./dialect.js";
import { attempt, inTransaction } from "./sql.js";
import { netOfWrites } from "./sweep-net.js";

/*
 * The staged-changes sweeper (RFC-0025): a `ChangeSource` over the queue a staged table's guard
 * files unarmed writes into, so a write made outside the mesh — another service's `UPDATE`, a
 * migration's backfill, a `psql` session — reaches it through the same bridge as CDC
 * (`startCapture`), as events the authority signs.
 *
 * A sweep takes every committed row no sweep has taken yet and gives them one number, higher than
 * any before it. A row whose transaction commits after a sweep is taken by a later one, so the
 * numbers follow commit order where it matters: two transactions that wrote one row cannot both
 * be in flight, so the second files its image after the first committed. One sweep is one
 * transaction on the stream and its number is the watermark, so a resume after the stored one
 * skips exactly the sweeps already in the log; the rows of a sweep are deleted once its events
 * are acked, and a sweep taken but never acked is sent again.
 */

export interface StagedOptions {
  /** The `_cdc` row the watermark is filed under. One per database: the queue has one reader. */
  readonly name: string;
  /** The connection the staged tables' guard writes the queue on: the authority's own. */
  readonly driver: SqlDriver;
  /** The synced tables, to read a row image back; a queued row of any other table is dropped. */
  readonly tables: readonly Table[];
  /** How long the stream waits for new rows when the queue is empty. Default 1 second. */
  readonly every?: Temporal.Duration;
}

export interface StagedChangeSource extends ChangeSource {
  /** Ends the wait of every open stream now, rather than after {@link StagedOptions.every}. */
  readonly sweep: () => void;
  /** How many rows the queue holds: written and not yet in the log. The backlog, to watch. */
  readonly pending: () => Promise<Result<number, StoreFailure>>;
}

/** The {@link StagedOptions.every} wait when none is given. */
export const STAGED_EVERY = Temporal.Duration.from({ seconds: 1 });

/** Twenty digits, so lexicographic order is numeric order — the port's one assumption. */
const watermarkAt = (sweep: number): Watermark =>
  parseWatermark(String(sweep).padStart(20, "0")).unwrap();

/** A watermark this source wrote, as the sweep it names; anything else reads as before every sweep. */
const sweepOf = (watermark: Watermark | null): number => {
  const sweep = watermark === null ? 0 : Number(watermark);
  return Number.isSafeInteger(sweep) && sweep > 0 ? sweep : 0;
};

/** A change's cells as the source row the bridge maps: keyed by the table's own column keys. */
const sourceRow = (table: Table, cells: Row, partition: string | null): SourceRow => ({
  _partition: partition,
  ...Object.fromEntries(
    Object.entries(table.columnNames).flatMap(([key, name]) => {
      const value = cells.get(name);
      return value === undefined ? [] : [[key, value] as const];
    }),
  ),
});

/**
 * One sweep's rows as one transaction: each row's net effect across every write the sweep took,
 * so an update carries only the columns those writes changed — a field the writer left alone is
 * no write to it, even when a fold or a captured write changed it between two of them — and a
 * counter carries the writer's own increments. `_partition` rides each row as the guard filed it:
 * the row's own once the mesh placed it, `null` on a row the outside writer inserted. The bridge
 * files an update to a held row the mapping cannot place in the instance the engine holds it in.
 */
function sweepMessages(
  tables: ReadonlyMap<string, Table>,
  rows: readonly SqlRow[],
  sweep: number,
): readonly ChangeMessage[] {
  const parts = new Map<string, string | null>();
  const logged = rows.map(
    ([tbl = null, op = null, key = null, part = null, old = null, next = null]) => {
      const [table, id] = [String(tbl), String(key)];
      parts.set(`${table} ${id}`, part === null ? null : String(part));
      return [table, id, op, old, next];
    },
  );
  const messages: ChangeMessage[] = [{ t: "begin" }];
  for (const net of netOfWrites(tables, logged)) {
    const change = netChange(net);
    if (change === undefined) continue;
    const table = net.table.name;
    const part = parts.get(`${table} ${net.key}`) ?? null;
    if (change.kind === "insert") {
      messages.push({ t: "insert", table, row: sourceRow(net.table, change.row, part) });
    } else if (change.kind === "update") {
      messages.push({
        t: "update",
        table,
        key: net.key,
        after: sourceRow(net.table, change.patch, part),
      });
    } else messages.push({ t: "delete", table, key: net.key });
  }
  messages.push({ t: "commit", watermark: watermarkAt(sweep) });
  return messages;
}

/** Rows read in sweep order, as one run per sweep. */
function bySweep(rows: readonly SqlRow[]): readonly (readonly [number, readonly SqlRow[]])[] {
  const runs: [number, SqlRow[]][] = [];
  for (const row of rows) {
    const sweep = Number(row[6]);
    const last = runs.at(-1);
    if (last?.[0] === sweep) last[1].push(row);
    else runs.push([sweep, [row]]);
  }
  return runs;
}

/** Every row a sweep above `after` took, after forgetting the ones at or below `done` and taking what is new. */
async function nextRows(
  driver: SqlDriver,
  sql: StagedSql,
  done: number,
  after: number,
): Promise<readonly SqlRow[]> {
  return inTransaction(driver, async () => {
    if (done > 0) await driver.run(sql.forget, [done]);
    const [newest] = await driver.all(sql.newest);
    const top = Math.max(Number(newest?.[0] ?? 0), after);
    await driver.run(sql.claim, [top + 1]);
    return driver.all(sql.read, [after]);
  });
}

/**
 * The staged-changes queue as a change source (RFC-0025): what lets a table be written both
 * through the mesh and by something outside it, without a write going unseen or being refused.
 *
 * Name the table in `strict: { stage: [...] }` where the stores are opened; an unarmed write to
 * it is then filed in the queue instead of refused, and this source, behind `startCapture`,
 * turns each sweep of the queue into events the authority signs. The mapping is the table onto
 * itself, placing a row the outside writer inserted. It returns `undefined` when the row says too
 * little — an update to a row the mesh never held carries only what changed — and capture stops
 * with `RowUnplaceable` rather than file the row in an instance nobody syncs:
 *
 * @example
 * ```ts
 * const stores = (await openStores(driver, { tables, strict: { stage: ["tasks"] } })).unwrap()
 * const source = stagedChangeSource({ name: "staged", driver: stores.driver, tables })
 * const running = (await startCapture({
 *   engine,
 *   source,
 *   mappings: {
 *     tasks: {
 *       collection: schema.tables.tasks,
 *       partition: (row) => {
 *         const org = scalarText(row.orgId)
 *         return scalarText(row._partition) ?? (org === undefined ? undefined : `org:${org}`)
 *       },
 *     },
 *   },
 * })).unwrap()
 * ```
 */
export function stagedChangeSource(options: StagedOptions): StagedChangeSource {
  const { driver, every = STAGED_EVERY } = options;
  const { staged } = driverDialect(driver).capture;
  const tables = new Map<string, Table>(options.tables.map((table) => [table.name, table]));
  const waits = new Set<() => void>();
  const wakeAll = () => {
    for (const wake of waits) wake();
  };

  return {
    name: options.name,
    sweep: wakeAll,
    pending: () =>
      attempt("could not count the staged changes", () =>
        inTransaction(driver, async () => {
          for (const sql of staged.ddl) await driver.run(sql);
          const [row] = await driver.all(staged.depth);
          return Number(row?.[0] ?? 0);
        }),
      ),
    start: async ({ after }) => {
      await inTransaction(driver, async () => {
        for (const sql of staged.ddl) await driver.run(sql);
      });
      let stopped = false;
      let sent = sweepOf(after);
      let acked = sent;
      let wake: (() => void) | undefined;
      const rest = () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, durationMs(every));
          function done() {
            clearTimeout(timer);
            waits.delete(done);
            wake = undefined;
            resolve();
          }
          wake = done;
          waits.add(done);
        });
      async function* pump(): AsyncGenerator<ChangeMessage> {
        while (!stopped) {
          const rows = await nextRows(driver, staged, acked, sent);
          if (rows.length === 0) {
            await rest();
            continue;
          }
          for (const [sweep, taken] of bySweep(rows)) {
            if (stopped) return;
            yield* sweepMessages(tables, taken, sweep);
            sent = sweep;
          }
        }
      }
      const stream: ChangeStream = {
        changes: pump(),
        // forgotten at the next sweep, in the stream's own turn on the connection
        ack: (watermark) => {
          acked = Math.max(acked, sweepOf(watermark));
        },
        stop: () => {
          stopped = true;
          wake?.();
        },
      };
      return stream;
    },
  };
}
