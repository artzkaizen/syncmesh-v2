import { is, Table } from "drizzle-orm";

/**
 * The builder methods that take a source and can therefore introduce an unscoped table. `from`
 * is the first of them rather than a different kind of thing; the lateral joins take a subquery,
 * which was built through a scoped `db` too, and are listed so a table handed to one is caught.
 */
const SOURCES = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
  "innerJoinLateral",
  "leftJoinLateral",
  "crossJoinLateral",
]);

/** The read verbs a query handler keeps; everything absent from this set is a write (§2.4). */
const READS = new Set(["select", "selectDistinct", "with", "$with", "$count", "$dynamic"]);

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, typescript/no-unsafe-return -- this module is a forwarding layer over Drizzle's builders, which are chained class instances with no public interface to narrow to and no declared shape to parse into. Every value here came *from* Drizzle and goes straight back *to* Drizzle; the one thing this code inspects is whether a source is a `Table`, and it does that with Drizzle's own `is()` rather than by guessing. Parsing anything else would mean inventing a domain type for a builder we deliberately do not model. The seam is narrow on purpose: two `get` traps, one method-name set each, and the fence's views of a session and its client. */

type Builder = Record<string | symbol, unknown>;

/**
 * What a builder carries that a handler must not reach: its `session` runs any statement on the
 * caller's connection (a `COMMIT`, a write) outside every fence here. Drizzle's own methods still
 * reach it, as they run on the builder itself.
 */
const HIDDEN = new Set<string | symbol>(["session"]);

/**
 * Wraps one builder so every source it is handed goes through `scope` first, **whatever was
 * chained before it**.
 *
 * A `Proxy` rather than a rebuilt object: a select builder carries internal symbol state that
 * Drizzle reads back on execution, it is a `PromiseLike` that runs on `await`, and `live()`
 * calls `toSQL()` on it — so anything that copies properties instead of forwarding them loses a
 * capability nobody would notice until a query ran.
 *
 * Drizzle's chain methods (`where`, `$dynamic`, `orderBy`, each join) mutate the builder and
 * return it, so a call that hands back the target hands back this proxy instead. Without that a
 * join chained after `where` reached the bare builder, and its table was read unscoped.
 */
const wrap = <B>(builder: B, scope: (source: unknown) => unknown): B => {
  const proxy: B = new Proxy(builder as Builder, {
    has: (target, property) => !HIDDEN.has(property) && Reflect.has(target, property),
    ownKeys: (target) => Reflect.ownKeys(target).filter((key) => !HIDDEN.has(key)),
    getOwnPropertyDescriptor: (target, property) =>
      HIDDEN.has(property) ? undefined : Reflect.getOwnPropertyDescriptor(target, property),
    get(target, property, receiver) {
      if (HIDDEN.has(property)) return undefined;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = value.bind(target);
      const sources = SOURCES.has(String(property));
      return (...args: readonly unknown[]) => {
        const [source, ...rest] = args;
        const result = sources ? method(scope(source), ...rest) : method(...args);
        if (result === target) return proxy;
        // `from` answers a new builder rather than itself: that one is chained on too
        return sources ? wrap(result, scope) : result;
      };
    },
  }) as B;
  return proxy;
};

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
      // `$count(table)` names its source directly, with no `from` to intercept
      if (property === "$count")
        return (source: unknown, ...rest: readonly unknown[]) =>
          wrap(method(scope(source), ...rest), scope);
      // `$with(alias).as(qb => …)` hands the callback a fresh builder of Drizzle's own
      if (property === "$with")
        return (...args: readonly unknown[]) => {
          const cte = method(...args) as { as: (qb: unknown) => unknown };
          return {
            as: (qb: unknown) =>
              cte.as(
                typeof qb === "function" ? (fresh: Builder) => qb(scopeReads(fresh, read)) : qb,
              ),
          };
        };
      // `with(cte)` answers the read verbs again, which build from a source like `select` does
      if (property === "with")
        return (...args: readonly unknown[]) => scopeReads(method(...args) as Builder, read);
      return (...args: readonly unknown[]) => wrap(method(...args), scope);
    },
  }) as Db;
};

/**
 * `target` as a `Proxy` that answers every property through `view`, read directly or through
 * its descriptor, so reflection reaches nothing `view` did not hand out. A function `view`
 * returns is called with the proxy as `this`, so what it reads from `this` is viewed too.
 */
const sealed = <T extends object>(
  target: T,
  view: (value: unknown, property: string | symbol, self: T) => unknown,
  before: () => void = () => undefined,
): T => {
  const proxy: T = new Proxy(target, {
    get: (at, property) => view(Reflect.get(at, property, proxy), property, proxy),
    getOwnPropertyDescriptor: (at, property) => {
      const own = Reflect.getOwnPropertyDescriptor(at, property);
      // a non-configurable property must be reported as it is: none of Drizzle's are
      if (own === undefined || !("value" in own) || own.configurable !== true) return own;
      return { ...own, value: view(own.value, property, proxy) };
    },
    // only a callable target is ever called: a driver's client can be, as postgres.js's `sql` is
    apply: (at, self, args) => {
      before();
      return (at as (...a: readonly unknown[]) => unknown).apply(self, args);
    },
  });
  return proxy;
};

/** A driver's client as a fence sees it: what Drizzle's session sends each statement through. */
export type DriverClient = Builder;

/**
 * `db`, until `revoke()`: from then on every statement it would send is refused before it reaches
 * the connection, whether it comes from `db` itself, a builder made from it, a query prepared
 * from it, or a function kept from any of them. A refused statement answers a rejected promise
 * carrying `refusal()`, or throws it where the driver is called.
 *
 * A Drizzle sends every statement through its `session`, which every builder copies when it is
 * made, and the session sends it through its `client` when it runs. Both are fenced: the session's
 * verbs refuse once revoked, and so does each function of the client, checked when it is called,
 * so a statement whose text was changed after it was built, or an executor kept by reflection,
 * is refused too. `guard` wraps the client first, for a caller that checks each statement itself.
 * This keeps a handler that kept its `db` (a timer, a cache, a closure) from running a statement
 * on whatever transaction holds that connection by then, or on none at all.
 *
 * @example
 * const { db: handlerDb, revoke } = revocable(tx, () => new Error("this read has ended"));
 * try { rows = await handler({ db: handlerDb }); } finally { revoke(); }
 */
export const revocable = <Db extends object>(
  db: Db,
  refusal: () => Error,
  guard: (client: DriverClient) => DriverClient = (client) => client,
) => {
  let revoked = false;
  const live = () => {
    if (revoked) throw refusal();
  };
  /** The driver's client: each of its functions checks the fence when it is called. */
  const client = (raw: DriverClient) => {
    const at = guard(raw);
    return sealed(
      at,
      (value) =>
        typeof value === "function"
          ? (...args: readonly unknown[]) => {
              live();
              return value.apply(at, args);
            }
          : value,
      live,
    );
  };
  const clients = new WeakMap<DriverClient, DriverClient>();
  /** A session, or what it prepares: its verbs refuse once revoked, and its client is fenced. */
  const fence = <T extends object>(target: T): T =>
    sealed(target, (value, property, self) => {
      if (property === "client" && (typeof value === "object" || typeof value === "function")) {
        if (value === null) return value;
        // SAFETY: a session's client is the driver's own object, read here only by property
        const raw = value as DriverClient;
        const fenced = clients.get(raw) ?? client(raw);
        clients.set(raw, fenced);
        return fenced;
      }
      if (typeof value !== "function") return value;
      return (...args: readonly unknown[]) => {
        // preparing sends nothing; what it prepares is fenced like the session it came from
        if (property === "prepareQuery") return fence(value.apply(self, args));
        if (revoked) return Promise.reject(refusal());
        return value.apply(self, args);
      };
    });
  const session = Reflect.get(db, "session");
  const fencedSession =
    typeof session === "object" && session !== null ? fence(session) : undefined;
  const fenced =
    fencedSession === undefined
      ? fence(db)
      : sealed(db, (value, property) => (property === "session" ? fencedSession : value));
  return {
    db: fenced,
    revoke: () => {
      revoked = true;
    },
  };
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
