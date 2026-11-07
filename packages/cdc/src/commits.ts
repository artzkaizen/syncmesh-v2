import { Result } from "@syncmesh/result";

import type { ChangeStream } from "./source.js";

import { SourceFailed } from "./errors.js";

/**
 * A change stream as the tables each committed transaction touched, and nothing more: what a
 * server that serves pages straight from the database needs to know to read a page again (D43).
 */
export interface CommitFeed {
  /** Called once per commit with every table it touched, in commit order. Returns the unsubscribe. */
  readonly onCommit: (listener: (tables: ReadonlySet<string>) => void) => () => void;
  /** Settles when the stream ends: `Ok` after {@link stop}, `Err` when the source failed. */
  readonly done: Promise<Result<void, SourceFailed>>;
  readonly stop: () => void;
}

/**
 * Reads `stream` and tells every listener which tables each transaction touched once it commits.
 * A `begin` drops what a half-sent transaction named, as the port promises.
 *
 * Each commit is acked once its listeners have heard it. Nothing is derived from a change here,
 * so there is nothing to make durable first: the database already holds the rows the listeners
 * read again.
 *
 * @example
 * const feed = commitFeed(await source.start({ after: null }));
 * feed.onCommit((tables) => tables.has("mail") && rereadInbox());
 */
export function commitFeed(stream: ChangeStream, source = "change source"): CommitFeed {
  const listeners = new Set<(tables: ReadonlySet<string>) => void>();
  const read = async (): Promise<void> => {
    let touched = new Set<string>();
    for await (const message of stream.changes) {
      if (message.t === "begin") touched = new Set();
      else if (message.t === "commit") {
        const tables = touched;
        touched = new Set();
        if (tables.size > 0) for (const listener of listeners) listener(tables);
        stream.ack(message.watermark);
      } else touched.add(message.table);
    }
  };
  return {
    onCommit: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    done: Result.tryPromise({
      try: read,
      catch: (cause) =>
        new SourceFailed({
          source,
          message: cause instanceof Error ? cause.message : "the change stream failed",
          cause,
        }),
    }),
    stop: stream.stop,
  };
}
