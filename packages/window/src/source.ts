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

/** Why a read was not served: no such procedure, an input it refuses, or a table the reader may not read. */
export class ReadRefused extends TaggedError("ReadRefused")<{ message: string }> {}

/**
 * Whatever runs a window's read on the server (D39): the app's `query` procedures over Postgres,
 * or memory in a test. It is built for one reader, so every page it returns is already what that
 * reader may see.
 */
export interface PageSource {
  /** Runs the read the request names and returns its page, or why it will not. */
  readonly readPage: (request: ReadRequest) => Promise<Result<Page, ReadRefused>>;
  /**
   * Committed changes, as the tables each transaction touched, in commit order. Returns the
   * unsubscribe.
   */
  readonly onCommit: (listener: (tables: ReadonlySet<string>) => void) => () => void;
}
