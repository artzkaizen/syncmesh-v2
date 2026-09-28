import { traceStatements } from "@syncmesh/sqlite-expo";

/**
 * What SQLite costs the JS thread, grouped by the turn of the event loop that spent it.
 *
 * `expo-sqlite` is used here through its `*Sync` surface, so a query is not a wait — it is the
 * thread itself, busy, not drawing and not listening for a touch. A tap that feels slow and a tap
 * that is waiting on a network are indistinguishable from the outside and have nothing in common
 * underneath, and this is the instrument that tells them apart: everything it reports is time
 * already spent, locally, before anything was sent anywhere.
 *
 * Grouped per turn rather than per statement because no single statement is the problem. One
 * `setStatus` is a validate, a read, an append, a fold and a projection upsert, and then every
 * live query over a table it touched re-runs — dozens of statements, each of them fast, adding up
 * to a frame budget spent many times over.
 */

/** A turn that spent less than this is not worth a line: the log is for the ones that stall. */
const WORTH_REPORTING_MS = 8;

/** How much of a statement identifies it in a log without wrapping the terminal. */
const SQL_SHOWN = 72;

interface Turn {
  statements: number;
  spent: number;
  rows: number;
  worstMs: number;
  worstSql: string;
  worstRows: number;
}

const fresh = (): Turn => ({
  statements: 0,
  spent: 0,
  rows: 0,
  worstMs: 0,
  worstSql: "",
  worstRows: 0,
});

let turn = fresh();
let queued = false;

const oneLine = (sql: string): string => sql.replaceAll(/\s+/gu, " ").trim().slice(0, SQL_SHOWN);

const flush = (): void => {
  queued = false;
  const { rows, spent, statements, worstMs, worstRows, worstSql } = turn;
  turn = fresh();
  if (spent < WORTH_REPORTING_MS) return;
  // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
  console.log(
    `[sql] ${String(statements)} stmts · ${String(spent)}ms blocked · ${String(rows)} rows · worst ${String(worstMs)}ms/${String(worstRows)} rows ${oneLine(worstSql)}`,
  );
};

/**
 * Starts reporting, once. Every call after the first does nothing.
 *
 * A macrotask is the grouping because the sync driver's promises settle as microtasks: a whole
 * write, its fold and every live query it invalidates drain before the loop turns, so a
 * `setTimeout(…, 0)` closes the group at exactly the boundary a person would call "the tap".
 */
export function watchSql(): void {
  traceStatements((sql, ms, rows) => {
    turn.statements += 1;
    turn.spent += ms;
    turn.rows += rows;
    if (ms >= turn.worstMs) {
      turn.worstMs = ms;
      turn.worstSql = sql;
      turn.worstRows = rows;
    }
    if (queued) return;
    queued = true;
    setTimeout(flush, 0);
  });
}
