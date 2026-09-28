import type { Engine } from "@syncmesh/engine";
import type { SQLWrapper } from "drizzle-orm";

import type { LiveChange, LiveDiff } from "./patch.js";

import { replaceEqualDeep } from "./equal.js";
import { diffOf, patchWindow, stateOf } from "./patch.js";
import { ROW_SYNC_TABLE } from "./sync-of.js";
import { identityOf, tablesOf } from "./tree.js";
import { keyOfRows, windowOf } from "./window.js";

/**
 * Before any local read has completed: `data` is empty and carries **no information**, so
 * there is nothing to key and nothing to diff — the only honest UI is a skeleton.
 *
 * `status` is `error` here when the first read fell over, which establishes nothing in either
 * direction; a caller reading `!isPending` would take that for an answer.
 */
export interface LiveUnanswered {
  readonly answered: false;
  readonly data: readonly never[];
  readonly status: "pending" | "error";
  readonly error: Error | undefined;
}

/**
 * A local read has completed, and `data` is what it returned.
 *
 * The fact any empty-state claim rests on, and **not** the same fact as `status`: a re-run that
 * failed keeps the last good rows and turns `status` to `error` without un-answering the
 * question. It is on the snapshot rather than beside it so it can never drift from the rows it
 * describes, and once reached it is never left.
 */
export interface LiveAnswered<T> {
  readonly answered: true;
  readonly data: readonly T[];
  /**
   * The same rows keyed by primary key — the identity the diff is decided by (book ch. 9).
   * Built once per delivery here, so a consumer keyed on rows never rebuilds a map to find one.
   */
  readonly state: ReadonlyMap<string, T>;
  /** What this delivery changed against the one before; every map empty on a failed re-run. */
  readonly diff: LiveDiff<T>;
  readonly status: "error" | "success";
  readonly error: Error | undefined;
}

/**
 * What a consumer reads, as one object whose **identity changes only when something changed** —
 * which is what lets `useSyncExternalStore` hold it without tearing, and what stops a component
 * re-rendering because an unrelated table was written.
 *
 * Two arms on `answered`, because `state` and `diff` describe rows and an unanswered query has
 * none to describe.
 */
export type LiveSnapshot<T> = LiveUnanswered | LiveAnswered<T>;

/**
 * Told the rows, and told what moved to get them — the second only when the query was
 * **maintained** rather than re-read (see {@link LiveWindow}).
 *
 * `undefined` is an honest answer and not a missing one: a re-run knows the new rows and has no
 * way to name the difference, because the fact that would have named it — which keys the fold
 * wrote — is the thing a re-run threw away. A consumer that can use a delta takes it when it is
 * there and diffs when it is not.
 */
export type LiveListener<T> = (rows: readonly T[], changes?: readonly LiveChange<T>[]) => void;

export interface Live<T> {
  /** The rows as of the last run; `undefined` until `ready` resolves. */
  readonly data: () => readonly T[] | undefined;
  /** The cached snapshot. Same reference until the rows or the error actually change. */
  readonly snapshot: () => LiveSnapshot<T>;
  readonly ready: Promise<readonly T[]>;
  /** Fires once per fold batch that touched one of the query's tables, and only when the rows changed. */
  readonly subscribe: (listener: LiveListener<T>) => () => void;
  readonly release: () => void;
}

/** What a live query needs from a Drizzle query: its SQL to find the tables, and to be awaited. */
export type Runnable<T> = SQLWrapper & PromiseLike<readonly T[]>;

/**
 * The question, or the way to ask it again.
 *
 * A factory is what buys incremental maintenance: the probe a fold triggers is this query with a
 * key filter added and the limit dropped, and a Drizzle builder is mutated by its own chained
 * calls — so narrowing the one the caller is holding would narrow the query it is about to
 * await. Handed a built query instead, every fold re-runs it whole, which is what this did
 * before and still does for anything it cannot maintain.
 */
export type LiveQuery<T> = Runnable<T> | (() => Runnable<T>);

const EMPTY: readonly never[] = [];
const NONE: ReadonlyMap<string, never> = new Map<string, never>();
const NO_DIFF: LiveDiff<never> = { added: NONE, removed: NONE, changed: NONE };

/**
 * Above this many changed keys, the probe stops being small and the re-run stops being the
 * expensive option — a catch-up folding a thousand events is one statement either way.
 */
const PROBE_KEYS = 100;

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/**
 * A re-run's rows with every unchanged row's identity restored — matched by key where the query
 * has one, so a row keeps its object across an insert above it; by position where it does not.
 * The array itself is `current` when nothing moved, which is the change decision.
 */
const mergeRows = <T>(
  current: readonly T[],
  before: ReadonlyMap<string, T>,
  fresh: readonly T[],
  keyOf: ((row: T) => string) | undefined,
): readonly T[] => {
  if (keyOf === undefined) return replaceEqualDeep(current, fresh);
  const rows = fresh.map((row) => {
    const was = before.get(keyOf(row));
    return was === undefined ? row : replaceEqualDeep(was, row);
  });
  const same = rows.length === current.length && rows.every((row, at) => row === current[at]);
  return same ? current : rows;
};

/**
 * What a live query re-runs on: the two feeds a fold announces itself through, and nothing else.
 *
 * Narrower than `Engine` on purpose. A tab that holds no engine — because the origin's one engine
 * is in another tab's worker — can satisfy this with fold batches that arrived over a port, and
 * then every live query in the repository works there unchanged.
 */
export type LiveSource = Pick<Engine, "onFoldBatch" | "onAcknowledge">;

/**
 * A live query is maintained from exact invalidation (D20 §4): the fold names the rows it wrote,
 * and a query that can be patched from those rows is, rather than asked again.
 *
 * Two queries asking the same question share one subscription and one re-run, refcounted by
 * `release` — two components rendering the same list used to run the same SQL twice per fold.
 */
export const createLive = (engine: LiveSource) => {
  const shared = new Map<string, { readonly live: Live<never>; refs: number }>();

  const build = <T>(query: Runnable<T>, rebuild: (() => Runnable<T>) | undefined): Live<T> => {
    const touched = tablesOf(query);
    // the row-sync table appears in raw SQL rather than as a Drizzle table, so the walk cannot
    // see it; the query's own text is what says whether a `syncOf` column was selected
    const sql = identityOf(query);
    const plan = rebuild === undefined ? undefined : windowOf(query, rebuild);
    const keyOf = keyOfRows(query);
    const listeners = new Set<LiveListener<T>>();
    let current: readonly T[] | undefined;
    let snap: LiveSnapshot<T> = {
      answered: false,
      data: EMPTY,
      error: undefined,
      status: "pending",
    };
    /** The rows as last keyed, which is what the next delivery is diffed against. */
    const held = (): ReadonlyMap<string, T> => (snap.answered ? snap.state : NONE);

    const publish = (rows: readonly T[], changes: readonly LiveChange<T>[] | undefined): void => {
      const state = stateOf(rows, keyOf);
      const diff = diffOf(held(), state);
      snap = { answered: true, data: rows, state, diff, error: undefined, status: "success" };
      for (const listener of listeners) listener(rows, changes);
    };

    const run = async (): Promise<readonly T[]> => {
      let fresh: readonly T[];
      try {
        fresh = await query;
      } catch (cause) {
        const error = asError(cause);
        // a failed run keeps the last good rows: a transient error must not blank a list — and
        // it keeps `answered` too, because a read that fell over has told the caller nothing
        // about what is in the store, in either direction
        snap = snap.answered
          ? { ...snap, diff: NO_DIFF, error, status: "error" }
          : { ...snap, error, status: "error" };
        for (const listener of listeners) listener(snap.data, undefined);
        throw error;
      }
      const rows = current === undefined ? fresh : mergeRows(current, held(), fresh, keyOf);
      const changed = rows !== current || snap.status !== "success";
      current = rows;
      if (changed) publish(rows, undefined);
      return rows;
    };

    /**
     * The whole point: one small statement for the keys the fold named, spliced into the rows
     * already in hand. `false` means it could not be done and the caller must re-read — which is
     * never wrong, only slower, so every doubt resolves that way.
     */
    const maintain = async (keys: ReadonlySet<string>): Promise<boolean> => {
      if (plan === undefined || current === undefined || snap.status !== "success") return false;
      if (keys.size === 0 || keys.size > PROBE_KEYS) return false;
      const probe = plan.probe([...keys]);
      if (probe === undefined) return false;
      const patched = patchWindow(plan, current, keys, await probe);
      if (patched === undefined) return false;
      current = patched.rows;
      if (patched.changes.length > 0) publish(patched.rows, patched.changes);
      return true;
    };

    /** Keys awaiting maintenance; `undefined` says the next run has to read everything. */
    let waiting: Set<string> | undefined = new Set();
    const step = async (): Promise<void> => {
      const keys = waiting;
      waiting = new Set();
      if (keys !== undefined && (await maintain(keys).catch(() => false))) return;
      await run();
    };

    /**
     * One run at a time, and one more if anything arrived while it was out.
     *
     * Two folds landing during one in-flight query used to start two runs whose `await`s could
     * settle in either order, so the **older** result could be the one that stuck. Coalescing
     * also collapses a burst — a catch-up of a thousand events is one re-run, not a thousand.
     */
    let running = false;
    let queued = false;
    const schedule = (): void => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      void step()
        .catch(() => undefined)
        .finally(() => {
          running = false;
          if (!queued) return;
          queued = false;
          schedule();
        });
    };

    /** A fold's verdict on this query: these keys moved, or `undefined` for "read it all again". */
    const wake = (keys: ReadonlySet<string> | undefined): void => {
      if (keys === undefined) waiting = undefined;
      else if (waiting !== undefined) for (const key of keys) waiting.add(key);
      schedule();
    };

    running = true;
    const ready = run().finally(() => {
      running = false;
      if (!queued) return;
      queued = false;
      schedule();
    });

    const off = engine.onFoldBatch((batch) => {
      let mine = false;
      let foreign = false;
      let keys: ReadonlySet<string> | undefined;
      for (const table of batch.writeTables) {
        const name = String(table);
        if (!touched.has(name)) continue;
        mine = true;
        // a write to another table this query reads — the one a read rule joins against — can
        // change which rows are visible without naming a single one of them; so can a batch
        // that named a table without naming its keys, which is a fold this build cannot read
        const written = name === plan?.table ? batch.writeKeys.get(table) : undefined;
        if (written === undefined) foreign = true;
        else keys = written;
      }
      if (mine) wake(foreign ? undefined : keys);
    });
    /**
     * An acknowledgement touches no row, so no fold names it — but it does change what a
     * `syncOf` column reads. Only a query that selected one subscribes, which is what makes
     * this opt-in per query: a report or a picker never re-runs on an ack at all.
     */
    const offAck = sql.includes(ROW_SYNC_TABLE)
      ? engine.onAcknowledge(() => wake(undefined))
      : undefined;

    return {
      data: () => current,
      snapshot: () => snap,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: () => {
        off();
        offAck?.();
      },
    };
  };

  const drop = (id: string): void => {
    const held = shared.get(id);
    if (held === undefined) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    shared.delete(id);
    held.live.release();
  };

  /* oxlint-disable anti-slop/no-chained-type-assertions -- one shared map cannot be typed per query, and no narrower type spans two different ones; the key is what fixes the row shape */
  return <T>(source: LiveQuery<T>): Live<T> => {
    /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a Drizzle builder is an object and never a function, so this *is* the parse: it tells the question from the way to ask it again without either having to carry a tag */
    const rebuild = typeof source === "function" ? source : undefined;
    // SAFETY: the same check narrowed `rebuild`, so the other arm is the query itself
    const query = rebuild === undefined ? (source as Runnable<T>) : rebuild();
    const id = identityOf(query);
    const held = shared.get(id);
    if (held !== undefined) {
      held.refs += 1;
      // SAFETY: the map is keyed by the query's own chunk tree, which is exactly what fixes the row shape — only a caller asking the identical question reads this entry back
      const live = held.live as unknown as Live<T>;
      return { ...live, release: () => drop(id) };
    }
    const live = build(query, rebuild);
    // SAFETY: erased on the way in and restored on the way out under the same key; the entry is unreachable except through that key
    shared.set(id, { live: live as unknown as Live<never>, refs: 1 });
    return { ...live, release: () => drop(id) };
  };
  /* oxlint-enable anti-slop/no-chained-type-assertions */
};
