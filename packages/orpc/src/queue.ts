import type { JsonValue } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";

import { Result, TaggedError, isTaggedError } from "@syncmesh/result";

import type { AuthorityLink, CallError } from "./api.js";

/**
 * An authority call that waits for the network (D10, re-homed): an oRPC link over a request row.
 *
 * D10 decided that syncmesh ships no request channel — an authority call fails like `fetch`, and
 * durable intent is a `.handler` mutation. What it left open was exactly this: *if* an
 * offline-queued call is ever needed, it is a **link** — a client transport — over a request row,
 * never a subsystem of the mesh. This is that link. It wraps another: a call that cannot reach
 * the authority is kept in `syncmesh_requests` and answered `AuthorityQueued`, and `drain` sends
 * what is kept when the app says the network is back, under the same request id — so a call that
 * did in fact land before the failure is answered from what the server kept, not run twice.
 *
 * Opt-in, per link. Nothing here runs on a timer or listens to a radio: an app that knows when
 * it is online — `$status`, a knock — calls `drain` then.
 */

/** The call is kept and will be sent when {@link QueuedLink.drain} next runs. */
export class AuthorityQueued extends TaggedError("AuthorityQueued")<{
  readonly path: string;
  readonly requestId: string;
  message: string;
}> {}

/** One kept call, as the table holds it. */
export interface QueuedRequest {
  readonly id: string;
  readonly path: string;
  readonly input: JsonValue;
  readonly attempts: number;
}

export interface QueuedLink {
  /** The link to hand `createClient`: sends now when it can, keeps the call when it cannot. */
  readonly link: AuthorityLink;
  /** Every call still kept, oldest first. What a screen lists as "waiting to send". */
  readonly pending: () => Promise<readonly QueuedRequest[]>;
  /**
   * Sends everything kept, in order, stopping at the first call that still cannot reach the
   * authority. A call that lands or is refused leaves the table; what it answered goes to
   * {@link QueuedLink.onSettled}, because its original caller has long since been told `AuthorityQueued`.
   */
  readonly drain: () => Promise<void>;
  readonly onSettled: (
    listener: (request: QueuedRequest, answer: ResultType<unknown, CallError>) => void,
  ) => () => void;
}

export interface QueuedLinkOptions {
  /**
   * Which failures mean "not now" rather than "no": kept and retried on `drain`. By default a
   * failure with no tag — the network, a timeout — and `AuthorityUnreachable`; a tagged refusal
   * is an answer, and keeping it would be asking the same question again for the same reason.
   */
  readonly retryable?: (error: CallError) => boolean;
}

const TABLE = "syncmesh_requests";

const notNow = (error: CallError): boolean =>
  !isTaggedError(error) || error._tag === "AuthorityUnreachable";

export function queuedLink(
  inner: AuthorityLink,
  driver: SqlDriver,
  options: QueuedLinkOptions = {},
): QueuedLink {
  const retryable = options.retryable ?? notNow;
  const mark = (n: number): string => (driver.dialect === "postgres" ? `$${String(n)}` : "?");
  const opened = driver.run(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, path TEXT NOT NULL, input TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  );
  const listeners = new Set<Parameters<QueuedLink["onSettled"]>[0]>();

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the link's own contract carries the input opaque: the procedure's schema already ran upstream, and a row that named the shape could keep only one procedure
  const keep = async (id: string, path: string, input: unknown): Promise<void> => {
    await opened;
    await driver.run(
      `INSERT INTO ${TABLE} (id, path, input, attempts, created_at) VALUES (${mark(1)}, ${mark(2)}, ${mark(3)}, 1, ${mark(4)}) ON CONFLICT(id) DO NOTHING`,
      [id, path, JSON.stringify(input ?? null), Date.now()],
    );
  };
  const forget = (id: string) => driver.run(`DELETE FROM ${TABLE} WHERE id = ${mark(1)}`, [id]);
  const pending = async (): Promise<readonly QueuedRequest[]> => {
    await opened;
    const rows = await driver.all(
      `SELECT id, path, input, attempts FROM ${TABLE} ORDER BY created_at ASC, id ASC`,
    );
    // SAFETY: the columns are the ones this module wrote, in the order it selected them
    return rows.map((row) => ({
      id: String(row[0]),
      path: String(row[1]),
      input: JSON.parse(String(row[2])) as JsonValue,
      attempts: Number(row[3]),
    }));
  };

  const link: AuthorityLink = async (path, input, call = {}) => {
    const id = call.requestId ?? crypto.randomUUID();
    const answered = await inner(path, input, { requestId: id });
    if (answered.isOk() || !retryable(answered.error)) return answered;
    await keep(id, path, input);
    return Result.err(
      new AuthorityQueued({
        path,
        requestId: id,
        message: `${path} could not reach the authority and is kept to send later`,
      }),
    );
  };

  const drain = async (): Promise<void> => {
    for (const request of await pending()) {
      const answered = await inner(request.path, request.input, { requestId: request.id });
      if (answered.isErr() && retryable(answered.error)) {
        await driver.run(`UPDATE ${TABLE} SET attempts = attempts + 1 WHERE id = ${mark(1)}`, [
          request.id,
        ]);
        return; // still not now: what is behind it waits too, in order
      }
      await forget(request.id);
      for (const listener of listeners) listener(request, answered);
    }
  };

  return {
    link,
    pending,
    drain,
    onSettled: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
