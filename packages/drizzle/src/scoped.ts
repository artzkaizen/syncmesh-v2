import { is, Table } from "drizzle-orm";

/**
 * The builder methods that take a source and can therefore introduce an unscoped table. Joins
 * are wrapped recursively because a chain names one table per call, and `from` is the first of
 * them rather than a different kind of thing.
 */
const SOURCES = new Set(["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin"]);

/** The read verbs a query handler keeps; everything absent from this set is a write (§2.4). */
const READS = new Set(["select", "selectDistinct", "with", "$with", "$count", "$dynamic"]);

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, typescript/no-unsafe-return -- this module is a forwarding layer over Drizzle's builders, which are chained class instances with no public interface to narrow to and no declared shape to parse into. Every value here came *from* Drizzle and goes straight back *to* Drizzle; the one thing this code inspects is whether a source is a `Table`, and it does that with Drizzle's own `is()` rather than by guessing. Parsing anything else would mean inventing a domain type for a builder we deliberately do not model. The seam is narrow on purpose: two `get` traps, one method-name set each. */

type Builder = Record<string | symbol, unknown>;

/**
 * Wraps one builder so every source it is handed goes through `scope` first.
 *
 * A `Proxy` rather than a rebuilt object: a select builder carries internal symbol state that
 * Drizzle reads back on execution, it is a `PromiseLike` that runs on `await`, and `live()`
 * calls `toSQL()` on it — so anything that copies properties instead of forwarding them loses a
 * capability nobody would notice until a query ran.
 */
const wrap = <B>(builder: B, scope: (source: unknown) => unknown): B =>
  new Proxy(builder as Builder, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = value.bind(target);
      if (!SOURCES.has(String(property))) return method;
      return (source: unknown, ...rest: readonly unknown[]) =>
        wrap(method(scope(source), ...rest), scope);
    },
  }) as B;

/**
 * The app's `db`, with every table it selects from replaced by the table **as this caller may
 * read it** — the subquery `read()` builds, carrying the compiled `allow.read` rule and the
 * partition pin.
 *
 * This exists because the two dialects disagreed about whether reads were scoped at all. On
 * Postgres with `rls: true` the database enforces the caller's view, so a plain `db.select()` is
 * already correct; on SQLite there is no RLS, so the rule applied **only if the handler
 * remembered to wrap each table in `read()`** — and the same handler was safe on the server, so
 * no server-side test would ever catch the omission. A surface where forgetting a call silently
 * widens what a caller can see is not a surface; scoping the source is the engine's job.
 *
 * The substitution is invisible because `read()` aliases its subquery to the table's own name,
 * so every column reference (`issue.title`) resolves exactly as it did against the bare table.
 * A source that is already a subquery, a CTE or a raw fragment is passed through untouched — it
 * was built by something that had to name its own sources, and those went through here too.
 *
 * Applied on both dialects rather than only where RLS is absent: the predicate is the same one
 * RLS compiles, so a Postgres reader filters twice and returns the same rows, which is what
 * every handler that called `read()` by hand was already doing on that dialect.
 */
export const scopeReads = <Db extends object>(db: Db, read: (table: never) => unknown): Db => {
  const scope = (source: unknown): unknown => (is(source, Table) ? read(source as never) : source);
  return new Proxy(db as Builder, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !READS.has(String(property))) return value;
      const method = value.bind(target);
      return (...args: readonly unknown[]) => wrap(method(...args), scope);
    },
  }) as Db;
};

/**
 * The same `db`, minus every verb that writes — what a `query` handler is given (§2.4).
 *
 * A query descriptor is inert until something runs it, and a hook may run it, re-run it on any
 * fold that touches its tables, or never run it at all. A write in there does not write once: it
 * mints **a new event per re-run**, forever. D26's watch-out named this and the type system did
 * nothing about it, because `context()` handed the same `db` to both kinds of handler.
 *
 * Both fences, because either alone is escapable: the type omits the write verbs so `db.insert`
 * does not compile, and the object genuinely does not carry them, so reaching one through a cast
 * is a `TypeError` at the call rather than a silent event.
 */
export type ReadOnlyDb<Db> = Pick<
  Db,
  Extract<keyof Db, "select" | "selectDistinct" | "with" | "$with" | "$count" | "$dynamic">
>;

export const readOnly = <Db extends object>(db: Db): ReadOnlyDb<Db> => {
  const kept: Record<string, unknown> = {};
  for (const verb of READS) {
    const value = (db as Builder)[verb];
    if (typeof value === "function") kept[verb] = value.bind(db);
  }
  return kept as ReadOnlyDb<Db>;
};
