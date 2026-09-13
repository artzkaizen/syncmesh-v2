import type { Mesh } from "@syncmesh/client";

import { Result } from "@syncmesh/result";

import type { DevtoolsSql } from "../contract.js";

import { QueryFailed, QueryRefused } from "../contract.js";

/**
 * A door that a person can type into, shaped so that the obvious thing to type is a read.
 *
 * Be clear about what this is not: `driver.all` will execute whatever SQLite or Postgres accepts,
 * so the checks below are a speed bump and not a boundary. What they buy is that writing stops
 * being the easy thing to reach for — and that matters more here than it looks, because the
 * *other* SQL door on a mesh is `mesh.on().db`, whose proxy classifies statements by regex and
 * turns a matching `insert` into a **signed event sent to every peer**. Somebody "just fixing a
 * row" through a handle has written to the whole mesh. A door that cannot be used that way by
 * accident is worth a few lines of refusal.
 *
 * The `core` check is the one rule here that is about data rather than about writes. That column
 * holds the exact bytes an author signed; `length(core)` is the reading a devtool is owed, and the
 * column itself is somebody's rows in hexadecimal. Refusing it by name will occasionally refuse a
 * legitimate query against an app table that happens to have a column called `core`, and that
 * trade is the right way round.
 */

const READS = /^(?:select|pragma)\b/iu;
const WEIGHED = /\b(?:octet_)?length\s*\(\s*core\s*\)/giu;
const CORE = /\bcore\b/iu;

/** Why this statement will not be carried, or `undefined` when it will. */
export function refusalFor(sql: string): string | undefined {
  const statement = sql.trim().replace(/;\s*$/u, "");
  if (!READS.test(statement))
    return "this door carries one SELECT or PRAGMA and nothing else — writes go through the app's own handle, where they become signed events";
  if (statement.includes(";"))
    return "one statement at a time: whatever follows a semicolon is how a read becomes a write";
  if (CORE.test(statement.replace(WEIGHED, "")))
    return "`core` holds the exact bytes an author signed; ask for `length(core)` and read the weight instead";
  return undefined;
}

export function createSqlDoor(query: NonNullable<Mesh["query"]>): DevtoolsSql {
  return {
    query: async (sql, params) => {
      const refusal = refusalFor(sql);
      if (refusal !== undefined) return Result.err(new QueryRefused({ sql, message: refusal }));
      return Result.tryPromise({
        try: () => query(sql, params),
        catch: (cause: unknown) => new QueryFailed({ sql, cause }),
      });
    },
  };
}
