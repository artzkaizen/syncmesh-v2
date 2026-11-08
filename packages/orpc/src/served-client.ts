import type { DriverClient } from "@syncmesh/drizzle";

import type { ServedReadsOptions } from "./served.js";

import { refused } from "./served-pass.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get -- this module wraps a postgres.js client, whose queries are class instances Drizzle hands straight back to itself: each is checked for the two members used here, `active` and `cancel`, and nothing else is read */

/** What a served read's statement text may start with: one read, never a transaction's control. */
const READ = /^\s*(?:select|with|\()/i;

/**
 * A postgres.js query as the watchdog sees it: a promise of its rows, whether it was sent and is
 * running, and how to stop it.
 */
interface Sent extends PromiseLike<unknown> {
  readonly active?: boolean;
  readonly executed?: boolean;
  readonly cancel: () => unknown;
}

const isSent = (query: unknown): query is Sent =>
  typeof query === "object" &&
  query !== null &&
  typeof Reflect.get(query, "cancel") === "function" &&
  typeof Reflect.get(query, "then") === "function";

/** Whether `db` is a postgres.js Drizzle: its `$client` is the postgres.js `sql` function. */
export const isPostgresJs = ({ db }: Pick<ServedReadsOptions, "db">) => {
  const client: unknown = Reflect.get(db, "$client");
  return (
    typeof client === "function" &&
    typeof Reflect.get(client, "unsafe") === "function" &&
    typeof Reflect.get(client, "begin") === "function"
  );
};

/**
 * The client a served pass's handlers send through: each statement must be one read, goes over
 * the extended protocol (a statement with no parameters would otherwise go as a simple query,
 * which runs every statement in its text), and is kept so it can be cancelled.
 *
 * `cancel` stops every statement still running with postgres.js's own `query.cancel()`, which
 * sends Postgres a cancel request over a socket of its own: a full pool cannot hold it up.
 * `settled` waits for every statement a handler started since `from`, so none is still queued
 * when the read ends.
 */
export const servedClient = () => {
  const sent: Sent[] = [];
  const guard = (raw: DriverClient) => {
    const unsafe: unknown = Reflect.get(raw, "unsafe");
    return {
      unsafe: (text: unknown, params: unknown, options: unknown) => {
        if (typeof unsafe !== "function")
          throw refused("a served read runs over postgres.js, and this client is not one");
        if (typeof text !== "string" || !READ.test(text))
          throw refused("a served read sends one SELECT at a time, and this is no SELECT");
        const extended = Object.assign({}, options, { simple: false });
        const query: unknown = unsafe.call(raw, text, params, extended);
        if (isSent(query)) sent.push(query);
        return query;
      },
    };
  };
  return {
    guard,
    /** How many statements have been sent: where the next read's begin. */
    mark: () => sent.length,
    settled: async (from: number) => {
      // a handler's chain can start a statement as the last one settles: wait until none does
      for (let seen = from; seen < sent.length;) {
        const pending = sent.slice(seen).filter((query) => query.executed === true);
        seen = sent.length;
        // its outcome is the handler's, not this read's
        await Promise.allSettled(pending);
      }
    },
    cancel: () => Promise.allSettled(sent.filter((q) => q.active === true).map((q) => q.cancel())),
  };
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get */
