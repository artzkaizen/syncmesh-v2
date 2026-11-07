import type { RetryPolicy } from "@syncmesh/temporal";

import { Result } from "@syncmesh/result";
import { Temporal, backoff, durationMs } from "@syncmesh/temporal";

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

/**
 * A feed's comings and goings: `lost` when its stream failed, so no commit is heard until it is
 * back, and `resumed` once a new stream is reading, which may have missed any number of them.
 */
export type FeedState =
  | { readonly kind: "lost"; readonly reason: string }
  | { readonly kind: "resumed" };

/** A {@link CommitFeed} that starts its stream again whenever it fails. */
export interface ResumableCommitFeed {
  /** Called once per commit, from whichever stream is reading. Returns the unsubscribe. */
  readonly onCommit: CommitFeed["onCommit"];
  /** Told when the stream fails and when a new one is reading. Returns the unsubscribe. */
  readonly onFeed: (listener: (state: FeedState) => void) => () => void;
  /** Settles once {@link stop} has ended the stream reading now. */
  readonly done: Promise<void>;
  readonly stop: () => void;
}

/** The {@link resumableCommitFeed} wait between starts when none is given. */
export const FEED_RETRY = {
  first: Temporal.Duration.from({ seconds: 1 }),
  most: Temporal.Duration.from({ seconds: 30 }),
} as const satisfies RetryPolicy;

/**
 * A commit feed that outlives its stream (D43). When the stream fails, or `start` does, every
 * `onFeed` listener hears `lost`; `start` is called again after `retry`, doubling while it keeps
 * failing; once a stream is reading they hear `resumed`. A server serving pages marks every
 * window failed on `lost`, and reads every one again on `resumed`, so a feed that died never
 * leaves a window claiming to be live.
 *
 * @example
 * const feed = resumableCommitFeed(() => source.start({ after: null }));
 * servedReads({ …, onCommit: feed.onCommit, onFeed: feed.onFeed });
 */
export function resumableCommitFeed(
  start: () => Promise<ChangeStream>,
  options: { readonly retry?: RetryPolicy; readonly source?: string } = {},
): ResumableCommitFeed {
  const { retry = FEED_RETRY, source = "change source" } = options;
  const commits = new Set<(tables: ReadonlySet<string>) => void>();
  const feeds = new Set<(state: FeedState) => void>();
  let stopped = false;
  let reading: CommitFeed | undefined;
  /** Cuts a wait between starts short, so `stop` does not wait out a backoff. */
  let wake: (() => void) | undefined;
  const tell = (state: FeedState) => {
    for (const listener of feeds) listener(state);
  };

  const run = async (): Promise<void> => {
    let failures = 0;
    let lost = false;
    while (!stopped) {
      const started = await Result.tryPromise({
        try: start,
        catch: (cause) =>
          new SourceFailed({
            source,
            message: cause instanceof Error ? cause.message : "the change stream would not start",
            cause,
          }),
      });
      let reason: string;
      if (started.isOk()) {
        const feed = commitFeed(started.value, source);
        reading = feed;
        // a stop that landed while this one started finds nothing reading: end it here
        if (stopped) feed.stop();
        const off = feed.onCommit((tables) => {
          for (const listener of commits) listener(tables);
        });
        if (lost) tell({ kind: "resumed" });
        lost = false;
        failures = 0;
        const ended = await feed.done;
        off();
        reading = undefined;
        if (stopped) return;
        reason = ended.isErr() ? ended.error.message : "the change stream ended";
      } else reason = started.error.message;
      if (!lost) tell({ kind: "lost", reason });
      lost = true;
      failures++;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, durationMs(backoff(retry, failures)));
      });
      wake = undefined;
    }
  };

  return {
    onCommit: (listener) => {
      commits.add(listener);
      return () => commits.delete(listener);
    },
    onFeed: (listener) => {
      feeds.add(listener);
      return () => feeds.delete(listener);
    },
    done: run(),
    stop: () => {
      stopped = true;
      reading?.stop();
      wake?.();
    },
  };
}
