import type { Result } from "@syncmesh/result";

import { TaggedError } from "@syncmesh/result";

import type { WindowRow } from "./frames.js";
import type { ReadRequest } from "./request.js";

/** One run of a read: its rows in order, and the tables it read them from. */
export interface Page {
  readonly rows: readonly WindowRow[];
  /** What a commit has to touch to change this page; the window re-reads on nothing else. */
  readonly tables: ReadonlySet<string>;
}

/**
 * Why a read is not served, and will not be however often it is asked: no such procedure, an
 * input it refuses, or a table the reader may not read.
 */
export class ReadRefused extends TaggedError("ReadRefused")<{ message: string }> {}

/**
 * A read that did not run this time: a statement timeout, a lost connection, a database
 * restarting, a change feed that stopped. The window keeps the rows it had and is read again.
 */
export class ReadFailed extends TaggedError("ReadFailed")<{ message: string }> {}

/**
 * The change feed a source hears commits from: `lost` when it stopped, so no commit is heard
 * until it is back, and `resumed` when a new one started, which may have missed any number.
 */
export type FeedState =
  | { readonly kind: "lost"; readonly reason: string }
  | { readonly kind: "resumed" };

/**
 * Whatever runs a window's read on the server (D43): the app's `query` procedures over Postgres,
 * or memory in a test. It is built for one reader, so every page it returns is already what that
 * reader may see.
 */
export interface PageSource {
  /** Runs the read the request names and returns its page, or why it will not. */
  readonly readPage: (request: ReadRequest) => Promise<Result<Page, ReadRefused | ReadFailed>>;
  /**
   * Runs several reads for the same reader at once, answering each in order, for a source that
   * can do that more cheaply than one at a time (one transaction, one snapshot). Without it each
   * is a `readPage`.
   */
  readonly readPages?: (
    requests: readonly ReadRequest[],
  ) => Promise<readonly Result<Page, ReadRefused | ReadFailed>[]>;
  /**
   * Committed changes, as the tables each transaction touched, in commit order. Returns the
   * unsubscribe.
   */
  readonly onCommit: (listener: (tables: ReadonlySet<string>) => void) => () => void;
  /**
   * The feed's comings and goings, for a source whose feed can stop. Without it the feed is
   * taken never to stop. Returns the unsubscribe.
   */
  readonly onFeed?: (listener: (state: FeedState) => void) => () => void;
}
