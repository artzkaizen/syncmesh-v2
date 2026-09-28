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
  /** The token this span's own statements carry; see {@link ServedHandle.sql} for what it decides. */
  readonly token: number;
  /**
   * Which kind of span this is, because only one of them owns a transaction.
   *
   * `rehearse` opens a capture of its own and always rolls it back, so a statement that is not
   * the rehearsal's must stay outside it. `under` opens none — the tab's own `BEGIN` does, if it
   * has one — so there is nothing for a statement to be trapped inside, and a body that writes
   * through the shared `handle.db` (a seed, a migration, an adapter's own statement) is ordinary
   * rather than a mistake. Making both wait would wedge exactly those callers against a span they
   * are themselves holding open.
   */
  readonly mode: "under" | "rehearse";
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
    /** Which span this statement came through; absent is an ordinary read (`protocol.ts`). */
    span?: number,
  ) => Promise<ProxyResult>;
  readonly enter: (
    owner: Owner,
    mode: "under" | "rehearse",
    token: number,
    named?: WriteNaming,
  ) => Promise<void>;
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

/**
 * How long a span may stay open before the host stops believing in it, in milliseconds.
 *
 * A span is a tab's body running on the other side of a port, and the host cannot see it. Almost
 * always it takes microseconds and `leave` follows immediately; what this is for is the case where
 * it never does — a window torn down between `enter` and `leave` whose `abandon` has not landed,
 * or a body waiting on something that will not come. That span holds the handle's turn and, since
 * a rehearsal owns a transaction, everything waiting on it too: one tab's stalled dry run would
 * otherwise be every tab's dead database.
 *
 * Ending it is safe in the direction that matters. A rehearsal's whole product is a verdict and
 * its transaction was always going to roll back, so abandoning one early costs a `can` that stays
 * false; abandoning a write is refused instead — `under` may hold an uncommitted `BEGIN` the tab
 * still means to commit, and guessing there would lose a write rather than a button.
 */
const SPAN_MS = 5_000;

const isBegin = (statement: string): boolean => /^\s*begin\b/i.test(statement);
const isSettle = (statement: string): boolean => /^\s*(commit|rollback)\s*;?\s*$/i.test(statement);

/**
 * @param report Called with the tab holding the turn when a write of theirs becomes an event.
 */
/**
 * The turn on one handle: who is inside it, and how a waiter gets in.
 *
 * Out here because it is a thing rather than a step — a queue, its holder, and the clock that says
 * whether the holder is still there. {@link serveHandle} decides what *busy* means and what to do
 * about a holder that has stopped talking; this only knows how to hand the handle over.
 */
function createTurn<Owner>(quiet: number) {
  let tail = Promise.resolve();
  let holder: Owner | undefined;
  let release: (() => void) | undefined;
  let touched = Date.now();

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

  return {
    held: (): Owner | undefined => holder,
    touch: (): void => {
      touched = Date.now();
    },
    quietFor: (): number => Date.now() - touched,
    /** Gives the handle up once the tab has nothing open on it; a no-op mid-span. */
    give: (busy: boolean): void => {
      if (busy) return;
      holder = undefined;
      const free = release;
      release = undefined;
      free?.();
    },
    /**
     * Waits for the turn, asking `nudge` whether what it is waiting for still exists.
     *
     * Asking once on the way in is not enough, and the difference is the whole bug: a tab that
     * arrives *during* the reload it is replacing finds a holder that fell silent a moment ago,
     * not long enough ago to be declared gone — so it queues, and a queue has nobody in it to ask
     * again. The waiting itself is `take`'s and is left alone: racing it would leave a second
     * claim queued behind this one, which is the deadlock this exists to prevent wearing a hat.
     */
    waitFor: async (owner: Owner, nudge: () => void): Promise<void> => {
      nudge();
      let waiting = true;
      const asking = setInterval(() => {
        if (waiting) nudge();
      }, quiet);
      asking.unref?.();
      try {
        await take(owner);
      } finally {
        waiting = false;
        clearInterval(asking);
      }
    },
  };
}

export function serveHandle<Owner>(
  handle: Handle,
  report: (owner: Owner, receipt: TxReceipt) => void,
  spanLimit: number = SPAN_MS,
): ServedHandle<Owner> {
  /** Drizzle transactions this tab has open on the handle; nested `BEGIN`s are counted, not merged. */
  let depth = 0;
  let scope: OpenScope | undefined;
  const turn = createTurn<Owner>(spanLimit);

  const off = handle.onCommit((receipt) => {
    const holder = turn.held();
    if (holder !== undefined) report(holder, receipt);
  });

  const give = (): void => turn.give(depth > 0 || scope !== undefined);

  /** The open span's sink when this statement belongs in it, and nothing when it does not. */
  const placed = (open: OpenScope | undefined, span: number | undefined): ProxySink | undefined => {
    if (open === undefined) return undefined;
    return open.mode === "under" || open.token === span ? open.sql : undefined;
  };

  const sql: ServedHandle<Owner>["sql"] = async (owner, statement, params, method, span) => {
    await waitFor(owner);
    turn.touch();
    /**
     * A statement is placed by the sink it came through, never by who sent it.
     *
     * Holding the turn is what keeps two *tabs* out of each other's transaction; it says nothing
     * about the one tab's own concurrency. A detail panel rehearsing a delete while its
     * `issues.get` reads is one tick with two statements in it, and feeding both into the open
     * span put the read inside a capture that had staged `DELETE` and would roll it back — so the
     * read answered empty and the panel said the row was not on this device, about a row the list
     * beside it was drawing. Nothing folded afterwards, so the empty answer stayed.
     *
     * A rehearsal's transaction therefore admits only the statements the rehearsal minted; anything
     * else from this tab waits for it to settle, which is what `createProxy` means in process by
     * "a statement on any other sink waits for the connection". The body cannot wait on itself,
     * because its own statements carry the token.
     *
     * **The wait is bounded, and that bound is not a detail.** Waiting is a correctness fix, and a
     * correctness fix that can hang the screen is a worse bug than the one it cures: a window torn
     * down between `enter` and `leave` leaves a span nothing on this side can settle, and every
     * read after it — including the next page's, because one served handle serves the whole origin
     * — would queue behind a body that no longer exists. Measured against a refresh storm, that is
     * an app that never draws a row again. So a waiter gives the span {@link SPAN_MS} and then goes
     * around it, back to the behaviour that was wrong but never stuck. `expire` below is what
     * clears the span itself; this is what makes the reads survive the gap before it does.
     */
    let waited = scope;
    while (waited !== undefined && waited.mode === "rehearse" && span !== waited.token) {
      const settled = await Promise.race([
        waited.done.then(() => true).catch(() => true),
        new Promise<false>((resolve) => {
          const patience = setTimeout(() => resolve(false), spanLimit);
          patience.unref?.();
        }),
      ]);
      if (!settled) break;
      waited = scope;
    }
    if (isBegin(statement)) depth += 1;
    // inside a span, the tab is the author: its statements go to the span's sink, not the shared
    // one — for `under` that is every statement it sends, because the span owns no transaction
    // for one to be trapped in and the capture is what the sink is for
    const into = placed(scope, span) ?? handle.sql;
    try {
      return await into(statement, params, method);
    } finally {
      if (isSettle(statement) && depth > 0) depth -= 1;
      give();
    }
  };

  /**
   * The tab is gone, or its body is never coming back. Rolls the rehearsal back and lets go.
   *
   * Only rehearsals: see {@link SPAN_MS}. A write that is taking its time keeps the handle, and a
   * tab that dies holding one is `abandon`'s to clean up, because that at least *knows* the tab
   * is gone rather than inferring it from a clock.
   */
  const expire = (open: OpenScope): void => {
    if (scope !== open || open.mode !== "rehearse") return;
    scope = undefined;
    if (depth > 0) {
      depth = 0;
      // to the sink that opened it: a transaction only settles for its own author
      void open.sql("rollback", [], "run").catch(() => undefined);
    }
    open.close();
    void open.done.catch(() => undefined);
    give();
  };

  const enter: ServedHandle<Owner>["enter"] = async (owner, mode, token, named = {}) => {
    await waitFor(owner);
    turn.touch();
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
    const held: OpenScope = {
      close: () => close(),
      done,
      mode,
      sql: (...args) => sink(...args),
      token,
    };
    scope = held;
    if (mode === "rehearse") {
      const limit = setTimeout(() => expire(held), spanLimit);
      limit.unref?.();
      void done.catch(() => undefined).finally(() => clearTimeout(limit));
    }
    await Promise.race([entered, done]);
  };

  const leave: ServedHandle<Owner>["leave"] = async (owner) => {
    turn.touch();
    const open = scope;
    if (open === undefined || turn.held() !== owner) return undefined;
    scope = undefined;
    open.close();
    try {
      return await open.done;
    } finally {
      give();
    }
  };

  const abandon: ServedHandle<Owner>["abandon"] = (owner) => {
    if (turn.held() !== owner) return;
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

  /**
   * Takes the handle back from a tab that is not coming back, on behalf of one that is waiting.
   *
   * The turn is what keeps two tabs out of each other's transaction, and it is given up when the
   * holder's statement finishes with nothing open. A tab that is *reloaded* mid-statement finishes
   * nothing: `bye` is best effort, a `MessagePort` reports no death of its own, and until the host
   * hears one or the other that tab is still the holder — so the origin's one handle belongs to a
   * page that no longer exists, and every tab opened afterwards waits behind it for ever. Measured
   * against a refresh storm, that is an app that never draws a row again.
   *
   * Silence is the evidence, and it is only read when somebody else wants the handle: a holder
   * that is merely slow keeps touching it with every statement, and a holder nobody is waiting on
   * is nobody's problem. What is reclaimed is what `abandon` reclaims, because it is the same
   * situation arrived at by a different route — the difference is only whether the host was told.
   */
  const reclaim = (waiting: Owner): void => {
    const holder = turn.held();
    if (holder === undefined || holder === waiting) return;
    if (turn.quietFor() < spanLimit) return;
    abandon(holder);
  };

  const waitFor = (owner: Owner): Promise<void> => turn.waitFor(owner, () => reclaim(owner));

  return {
    sql,
    enter,
    leave,
    abandon,
    idle: () => turn.held() === undefined && depth === 0 && scope === undefined,
    stop: off,
  };
}
