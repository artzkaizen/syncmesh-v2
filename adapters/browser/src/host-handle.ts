import type { Handle } from "@syncmesh/client";
import type { ProxyMethod, ProxyResult, ProxySink, Span, WriteNaming } from "@syncmesh/drizzle";
import type { Result } from "@syncmesh/result";
import type { SqlWriteError, TxReceipt } from "@syncmesh/storage";

/**
 * The tab speaking into a handle is a type parameter, not a shape: `serveMesh` owns what a client
 * is, and this file only ever compares one for identity.
 */

/** The host-side scope a tab opened and has not closed: `under` or `rehearse`, mid-body. */
interface OpenScope {
  readonly close: () => void;
  readonly done: Promise<Result<void, SqlWriteError> | undefined>;
  /**
   * The span's own sink, which the tab's statements are fed into for as long as the scope is
   * open. The handle's shared `sql` is everybody's, so a transaction opened on it admits every
   * other statement that arrives — including a read this tab never asked for — and a rehearsal
   * opened on it would not admit the tab's own. This is the span that makes the tab the author.
   */
  readonly sql: ProxySink;
}

/**
 * One host-side handle, with a turn on it, so two tabs cannot interleave inside one connection.
 *
 * A `Handle` is one connection and a connection has one transaction — `createProxy` says so, and
 * its rule is "fire statements at a handle from inside the transaction that owns it, never from a
 * task running beside one". Two tabs on one origin are exactly the task running beside one: tab
 * B's bare `SELECT`, arriving while tab A's `BEGIN` is open, would execute *inside tab A's
 * transaction* and be rolled back with it. So the turn is taken for the whole of a tab's span —
 * its `BEGIN` through its `COMMIT`, or its `enter` through its `leave` — and the other tab waits.
 *
 * That is also what makes a receipt attributable: only one tab is inside at a time, so the event a
 * commit produced belongs to whoever is holding.
 *
 * Inside a span the turn is not the only thing keeping the tab's statements together: the span has
 * a statement sink of its own ({@link Handle.span}), and the tab's statements are fed into that
 * rather than the shared one, so the *host's* own reads are outside the tab's transaction too.
 */
export interface ServedHandle<Owner> {
  readonly sql: (
    owner: Owner,
    statement: string,
    params: readonly unknown[],
    method: ProxyMethod,
  ) => Promise<ProxyResult>;
  readonly enter: (owner: Owner, mode: "under" | "rehearse", named?: WriteNaming) => Promise<void>;
  /** Closes the scope and answers with the rehearsal's verdict, or nothing for `under`. */
  readonly leave: (owner: Owner) => Promise<Result<void, SqlWriteError> | undefined>;
  /**
   * The tab went away mid-span. Rolls back whatever it left open and hands the handle on — a
   * transaction nobody will ever commit would otherwise wedge every other tab on this instance.
   */
  readonly abandon: (owner: Owner) => void;
  /** Whether anything is still held for this owner: what a leak check reads. */
  readonly idle: () => boolean;
  readonly stop: () => void;
}

const isBegin = (statement: string): boolean => /^\s*begin\b/i.test(statement);
const isSettle = (statement: string): boolean => /^\s*(commit|rollback)\s*;?\s*$/i.test(statement);

/**
 * @param report Called with the tab holding the turn when a write of theirs becomes an event.
 */
export function serveHandle<Owner>(
  handle: Handle,
  report: (owner: Owner, receipt: TxReceipt) => void,
): ServedHandle<Owner> {
  let tail = Promise.resolve();
  let holder: Owner | undefined;
  let release: (() => void) | undefined;
  /** Drizzle transactions this tab has open on the handle; nested `BEGIN`s are counted, not merged. */
  let depth = 0;
  let scope: OpenScope | undefined;

  const off = handle.onCommit((receipt) => {
    if (holder !== undefined) report(holder, receipt);
  });

  const take = async (owner: Owner): Promise<void> => {
    if (holder === owner) return;
    const ahead = tail;
    let free!: () => void;
    tail = new Promise<void>((resolve) => {
      free = resolve;
    });
    await ahead;
    holder = owner;
    release = free;
  };

  /** Gives the handle up once the tab has nothing open on it; a no-op mid-span. */
  const give = (): void => {
    if (depth > 0 || scope !== undefined) return;
    holder = undefined;
    const free = release;
    release = undefined;
    free?.();
  };

  const sql: ServedHandle<Owner>["sql"] = async (owner, statement, params, method) => {
    await take(owner);
    if (isBegin(statement)) depth += 1;
    // inside a span, the tab is the author: its statements go to the span's sink, not the shared one
    const into = scope?.sql ?? handle.sql;
    try {
      return await into(statement, params, method);
    } finally {
      if (isSettle(statement) && depth > 0) depth -= 1;
      give();
    }
  };

  const enter: ServedHandle<Owner>["enter"] = async (owner, mode, named = {}) => {
    await take(owner);
    let opened!: () => void;
    const entered = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let close!: () => void;
    // the body is on the other thread: it "runs" for exactly as long as the tab keeps it open
    const body = () =>
      new Promise<void>((resolve) => {
        close = resolve;
        opened();
      });
    /** Where this tab's statements go while it is inside: set before its body is let go. */
    let sink = handle.sql;
    const inSpan = (span: Span<Handle["db"]>) => {
      sink = span.sql;
      return body();
    };
    // a rehearsal's span is the one its own transaction was opened on; `under` opens no
    // transaction of its own — the tab's `BEGIN` does — so its span is minted here
    const done =
      mode === "rehearse"
        ? handle.rehearse(inSpan)
        : handle.under(named, () => inSpan(handle.span())).then(() => undefined);
    scope = { close: () => close(), done, sql: (...args) => sink(...args) };
    await Promise.race([entered, done]);
  };

  const leave: ServedHandle<Owner>["leave"] = async (owner) => {
    const open = scope;
    if (open === undefined || holder !== owner) return undefined;
    scope = undefined;
    open.close();
    try {
      return await open.done;
    } finally {
      give();
    }
  };

  const abandon: ServedHandle<Owner>["abandon"] = (owner) => {
    if (holder !== owner) return;
    const open = scope;
    if (depth > 0) {
      depth = 0;
      // to the sink that opened it: a transaction only settles for its own author
      void (open?.sql ?? handle.sql)("rollback", [], "run").catch(() => undefined);
    }
    scope = undefined;
    if (open !== undefined) {
      open.close();
      void open.done.catch(() => undefined);
    }
    give();
  };

  return {
    sql,
    enter,
    leave,
    abandon,
    idle: () => holder === undefined && depth === 0 && scope === undefined,
    stop: off,
  };
}
