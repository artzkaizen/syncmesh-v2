import type { Change, PartitionKey } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type {
  SqlDriver,
  SqlValue,
  SqlWriteError,
  TxReceipt,
  SqlWriteOptions,
  Write,
  WriteLabel,
} from "@syncmesh/storage";

import { Result as R } from "@syncmesh/result";
import { inTransaction, onConnection } from "@syncmesh/storage";

/**
 * What a Drizzle proxy callback does over a mesh: `begin`/`commit`/`rollback` from Drizzle's own
 * `db.transaction()` open and settle one capture, a write statement on its own is its own
 * capture, and everything else runs as it is. Shared by the SQLite and Postgres faces; the
 * dialect decides only how values bind and how rows come back.
 *
 * **A statement is placed by the sink it came through, never by when it arrived.** Drizzle's proxy
 * callback is told the SQL and nothing about who asked, so a handle hands out more than one
 * callback: {@link createProxy.callback} is the shared surface under `db`, and
 * {@link createProxy.scope} mints a fresh one for a write that wants the handle to itself — a
 * rehearsal, or the transaction a mutation runs in. A transaction remembers which sink opened it
 * and admits statements from that sink alone; everything else takes the driver's turn
 * ({@link onConnection}) and therefore runs *after* it, on committed state.
 *
 * That rule replaces "one handle takes one turn at a time", which only ever held between
 * transactions. A bare `SELECT` is not a transaction and took no turn, so it executed on the one
 * connection *inside* whatever was open — a read beside a rehearsal saw the rehearsal's staged
 * DELETE and answered "no such row" about a row that was never deleted, and a read beside a write
 * that then rolled back saw a value nothing ever committed. Both are the same bug, and time cannot
 * tell those reads from the transaction's own statements: authorship can.
 *
 * What this does **not** cover: a transaction opened by a bare `begin` on the shared sink — which
 * is what `handle.sql("begin")` does for a statement stream arriving over a port. That sink is
 * everybody's, so the statements that follow cannot be told from a reader's, and they still join.
 * Open one with the handle's own `db.transaction`, which mints a scope, or hold a scope around the
 * stream (`adapters/browser`'s `serveHandle` does).
 */

export interface ProxyResult {
  readonly rows: unknown[][];
}

/** Drizzle's `run` (SQLite) executes for effect; every other method wants rows back. */
export type ProxyMethod = "run" | "all" | "values" | "get" | "execute";

/**
 * One statement sink: Drizzle's proxy callback, and the thing a handle hands out per author. Its
 * identity is the authorship — two sinks over one connection are two callers, and the proxy owes
 * them different answers.
 */
export type ProxySink = (
  statement: string,
  params: readonly unknown[],
  method: ProxyMethod,
) => Promise<ProxyResult>;

export interface ProxyDeps {
  readonly driver: SqlDriver;
  readonly writer: Write;
  readonly partition?: PartitionKey;
  /**
   * Runs inside every transaction before the app's statements — the Postgres face sets the
   * caller's principal here (RLS reads it), so it dies with the transaction. A bare read gets a
   * transaction of its own to hold it.
   */
  readonly prelude?: () => Promise<void>;
  /**
   * The receipt of every event these statements produce, as each one commits. A write that
   * changed nothing is not an event and is not reported; a write that failed raises instead.
   */
  readonly onCommit?: (receipt: TxReceipt) => void;
}

const isWrite = (statement: string): boolean => /^\s*(insert|update|delete)\b/i.test(statement);

/** The label an event carries when nobody named it: what the transaction turned out to do. */
const derivedLabel = (changes: readonly Change[]): string =>
  changes.length === 0
    ? "sql.write"
    : [...new Set(changes.map((c) => `${String(c.table)}.${c.kind}`))].join("+");

/**
 * What the caller already knows about the write it is about to make, and the proxy cannot.
 *
 * Both halves exist for the same reason: **this callback is handed SQL and nothing about who
 * asked for it.** Drizzle calls it with a statement, some parameters and a method, so the only
 * thing the proxy can say about a write on its own is what the statement turned out to touch —
 * `issue.update`, when the procedure that ran was `issues.move`. That is a fact about the
 * database, offered where a reader wants a fact about the application, and it is the reason the
 * write ledger reads like a table of SQL verbs.
 *
 * So a caller that *does* know says so, for the length of one call. `label` is the procedure's
 * own name; absent, {@link derivedLabel} still answers, because plenty of writes have no
 * procedure above them — a seed, a migration, a statement an adapter issues — and inventing a
 * name for those would be worse than deriving one.
 */
export interface WriteNaming {
  /** The operation id the caller allocated before the call and already handed its user (ch. 10). */
  readonly id?: string | undefined;
  /** The procedure this write *is*: `issues.move`, never `issue.update`. */
  readonly label?: string | undefined;
}

/** Where one rehearsal's verdict is left for {@link createProxy.rehearse} to pick up. */
interface Rehearsal {
  verdict?: Result<void, SqlWriteError>;
}

/** The receipt shape a rehearsal's transaction settles with; it names no event, because none exists. */
// SAFETY: an EventId is a branded string, and this one is a sentinel no real event can collide
// with — it never leaves the rehearsal, because `commit` suppresses the receipt in that mode
const REHEARSED: TxReceipt = { eventId: "rehearsed-0" as TxReceipt["eventId"] };

/** Carries Drizzle's `rollback` out through the capture without it becoming an app error. */
class TxRollback extends Error {}

/** Drizzle hands values as it mapped them; SQLite has no boolean, Postgres has. */
const bind = (params: readonly unknown[], dialect: SqlDriver["dialect"]): readonly SqlValue[] =>
  params.map((p) => {
    if (p === undefined || p === null) return null;
    if (p === true) return dialect === "postgres" ? true : 1;
    if (p === false) return dialect === "postgres" ? false : 0;
    // SAFETY: Drizzle maps every other column value to a SQL scalar (string, number, bigint), a Date or bytes before the driver sees it
    return p as SqlValue;
  });

const NO_ROWS: ProxyResult = { rows: [] };

/** One transaction open on a handle: Drizzle's `begin` opened it, its `commit` settles it. */
interface OpenTx {
  readonly done: () => void;
  readonly fail: (cause: unknown) => void;
  readonly settled: Promise<Result<TxReceipt, SqlWriteError>>;
  /** The sink that opened it, and the only one whose statements it admits. */
  readonly author: ProxySink;
  /** Set when this transaction is a rehearsal: judged, then rolled back, and no receipt reported. */
  readonly rehearsal: Rehearsal | undefined;
  /** Hands the handle on to whoever queued behind this transaction. */
  readonly release: () => void;
}

/**
 * The handle's turn, taken for the whole of one transaction — its BEGIN through its settle, and a
 * rehearsal's first statement through its rollback. Awaiting the returned promise is the wait;
 * calling what it resolves to is handing the turn on.
 *
 * The queue is extended synchronously, before the wait, rather than after it: two callers arriving
 * in the same tick would otherwise both read the same tail, both believe the handle is theirs, and
 * overwrite each other's open transaction. That is how a rehearsal came to have its `DELETE`
 * committed by an ordinary write's COMMIT — one connection, one transaction, and no way to tell
 * whose statement is whose once the slot has been taken twice.
 */
const turnstile = () => {
  let tail: Promise<void> = Promise.resolve();
  return (): Promise<() => void> => {
    const ahead = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return ahead.then(() => release);
  };
};

/** One statement on the connection, shaped the way the method Drizzle asked for wants it. */
const executorFor =
  (driver: SqlDriver) =>
  async (
    statement: string,
    params: readonly SqlValue[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => {
    if (method === "run") {
      await driver.run(statement, params);
      return NO_ROWS;
    }
    const rows = await driver.all(statement, params);
    return { rows: method === "get" ? [[...(rows[0] ?? [])]] : rows.map((r) => [...r]) };
  };

/**
 * A read from a sink that owns nothing: it waits for the connection rather than joining whatever
 * is open on it, which is the whole of the fix. `prelude` needs a transaction of its own to hold
 * the settings; without one the turn is taken bare, because a `BEGIN IMMEDIATE` per `SELECT` would
 * take SQLite's write lock to answer a question.
 */
const readerFor =
  (deps: ProxyDeps, execute: ReturnType<typeof executorFor>) =>
  (statement: string, params: readonly SqlValue[], method: ProxyMethod): Promise<ProxyResult> => {
    const { driver, prelude } = deps;
    return prelude === undefined
      ? onConnection(driver, () => execute(statement, params, method))
      : inTransaction(driver, async () => {
          await prelude();
          return execute(statement, params, method);
        });
  };

export function createProxy(deps: ProxyDeps) {
  const { driver, writer, partition, prelude, onCommit } = deps;
  const baseOptions = partition === undefined ? {} : { partition };
  /** Set for the length of one call: what the caller knows about the write and the proxy cannot. */
  let naming: WriteNaming = {};
  const writeOptions = (): SqlWriteOptions =>
    naming.id === undefined ? baseOptions : { ...baseOptions, operationId: naming.id };
  /** The name this write goes into the ledger under: the caller's, or what it turned out to do. */
  const labelling = (): WriteLabel => naming.label ?? derivedLabel;

  let openTx: OpenTx | undefined;
  const takeTurn = turnstile();
  const execute = executorFor(driver);
  const readOutside = readerFor(deps, execute);

  /** Clears the slot and gives the turn back, whatever the transaction settled as. */
  const settle = async (tx: OpenTx): Promise<Result<TxReceipt, SqlWriteError>> => {
    openTx = undefined;
    try {
      return await tx.settled;
    } finally {
      tx.release();
    }
  };

  const begin = async (author: ProxySink, staged?: Rehearsal): Promise<OpenTx> => {
    // read before the wait: the id and the name belong to the call that asked for the
    // transaction, not to whatever `under` happens to be running by the time its turn comes round
    const options = writeOptions();
    const label = labelling();
    const release = await takeTurn();
    let began!: () => void;
    let done!: () => void;
    let fail!: (cause: unknown) => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = reject;
    });
    const run = () => {
      began(); // the capture transaction is now open; statements may flow
      return gate;
    };
    const settled: Promise<Result<TxReceipt, SqlWriteError>> =
      staged === undefined
        ? writer(label, run, options)
        : writer.rehearse(run, options).then((verdict) => {
            staged.verdict = verdict;
            // the rehearsal's own rollback is not a failure to report: the verdict is the answer
            return R.ok(REHEARSED);
          });
    const tx: OpenTx = { done, fail, settled, author, rehearsal: staged, release };
    openTx = tx;
    // a writer that dies before it opens — a broken connection — settles without ever calling
    // `run`, and waiting on `started` alone would hold the handle's turn for ever
    const opened = await Promise.race([started.then(() => true), settled.then(() => false)]);
    if (!opened) {
      const failed = await settle(tx);
      throw failed.isErr() ? failed.error : new Error("the transaction closed before it opened");
    }
    await prelude?.(); // the capture transaction is open: the settings land inside it
    return tx;
  };

  /** The open transaction, to the sink that opened it: a stray `commit` elsewhere is not its to give. */
  const held = (author: ProxySink): OpenTx | undefined =>
    openTx?.author === author ? openTx : undefined;

  const commit = async (author: ProxySink): Promise<void> => {
    const tx = held(author);
    if (tx === undefined) return;
    tx.done();
    const written = await settle(tx);
    // a read-only transaction is fine — it just is not an event
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
    // a rehearsal committed nothing, so there is no receipt anyone should hear about
    if (written.isOk() && tx.rehearsal === undefined) onCommit?.(written.value);
  };

  const rollback = async (author: ProxySink): Promise<void> => {
    const tx = held(author);
    if (tx === undefined) return;
    tx.fail(new TxRollback());
    await settle(tx); // the capture rolled back; Drizzle rethrows the app's own error
  };

  /** A write statement on its own is its own transaction, hence its own event. */
  const writeAlone = async (
    statement: string,
    params: readonly SqlValue[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => {
    let result: ProxyResult = NO_ROWS;
    // both read before the write opens, for the same reason `begin` reads them before its wait
    const label = labelling();
    const options = writeOptions();
    const written = await writer(
      label,
      async () => {
        await prelude?.();
        result = await execute(statement, params, method);
      },
      options,
    );
    // a statement that changed nothing is not an event, and not an error either
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
    if (written.isOk()) onCommit?.(written.value);
    return result;
  };

  const dispatch = (
    author: ProxySink,
    statement: string,
    params: readonly unknown[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => {
    const control = statement.trim().toLowerCase();
    if (control.startsWith("begin")) return begin(author).then(() => NO_ROWS);
    if (control === "commit") return commit(author).then(() => NO_ROWS);
    if (control === "rollback") return rollback(author).then(() => NO_ROWS);
    const bound = bind(params, driver.dialect);
    if (held(author) !== undefined) return execute(statement, bound, method);
    if (!isWrite(statement)) return readOutside(statement, bound, method);
    return writeAlone(statement, bound, method);
  };

  /** A sink is its own author: the closure's identity is what its transaction remembers. */
  const sink = (): ProxySink => {
    const own: ProxySink = (statement, params, method) => dispatch(own, statement, params, method);
    return own;
  };

  const callback = sink();

  /**
   * Runs `open` inside a capture the writer judges and then always rolls back: every statement in
   * it faces the same ladder a real write faces, and the answer is the verdict, not an outcome —
   * nothing happened (book ch. 15).
   *
   * The rehearsal opens the capture on `author`, a sink of its own, and holds the handle's turn
   * for as long as the body runs, so nothing else on this handle can commit between its first
   * statement and its rollback — and nothing else can *read* inside it either, because a statement
   * on any other sink waits for the connection. A savepoint around the body would have let the two
   * overlap, and SQLite does offer one, but a savepoint bounds statements by *time* rather than by
   * author: on a single connection every statement in the window — including the ordinary write
   * that arrived meanwhile — would be rolled back with it. Capture is worse still, being one armed
   * log folded into one event at COMMIT, so a rehearsal nested in a write would have its staged
   * rows judged and shipped as part of that write. Bounding by author is what a savepoint could
   * not do, and it is why the body writes through `author` rather than through `db`: a body that
   * reaches for the shared sink waits for a transaction it is itself holding open.
   */
  const rehearse = async (
    author: ProxySink,
    open: () => Promise<void>,
  ): Promise<Result<void, SqlWriteError>> => {
    const staged: Rehearsal = {};
    const tx = await begin(author, staged);
    try {
      await open();
      await commit(author); // the ladder judges, and the writer refuses: everything rolls back
    } finally {
      // only while this rehearsal's own transaction is still the open one: settling gives the turn
      // back, and the next caller's transaction is not this one's to roll back
      if (openTx === tx) await rollback(author); // a body that threw never reached the judging
    }
    return staged.verdict ?? R.ok(undefined);
  };

  /**
   * Runs `open` under what the caller knows about it: the operation id it already handed its user
   * (book ch. 10), and the procedure it is ({@link WriteNaming}).
   *
   * Scoped to the one call, so a second write started meanwhile records under its own — and the
   * previous naming is put back rather than cleared, because a nested call must not silently
   * rename the write it is inside.
   */
  const under = async <T>(named: WriteNaming, open: () => Promise<T>): Promise<T> => {
    const held = naming;
    naming = named;
    try {
      return await open();
    } finally {
      naming = held;
    }
  };

  return { callback, scope: sink, rehearse, under };
}
