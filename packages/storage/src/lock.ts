import { Result, TaggedError } from "@syncmesh/result";

/** Another live connection already holds `path`'s store open — a second open fails now, never corrupts silently. */
export class StoreLocked extends TaggedError("StoreLocked")<{
  readonly path: string;
  cause?: unknown;
}> {}

/**
 * An exclusive hold on one store's data, kept for the life of the open.
 *
 * **One lock, both files.** A store is a state file and its log (RFC-0022), and they are opened,
 * rebuilt and forgotten as a unit — so the hold is over the pair rather than over either half.
 * Nothing opens a log without the state file it belongs to, and nothing deletes one without the
 * other; `storeFilesFor` is the list, and this is what says only one opener may hold it.
 */
export interface StoreLock {
  /** Lets the next opener in; closing the store calls this. */
  readonly release: () => void;
}

/**
 * Takes the exclusive lock guarding one store: a `BEGIN EXCLUSIVE` held open on a sidecar
 * `<path>.lock` database, so the hold is SQLite's own file lock — released by `release`
 * (which closes the connection) or by the process dying, never leaked past either.
 *
 * The adapter supplies the connection primitives; a `run` that throws because another
 * holder exists becomes `StoreLocked`, and the sidecar connection is closed on the way out.
 *
 * @example
 * const lock = acquireStoreLock({ path, run: (sql) => db.run(sql), close: () => db.close() });
 */
export function acquireStoreLock(options: {
  /** The store file the lock guards — what `StoreLocked` reports. */
  readonly path: string;
  /** Runs one statement on the sidecar lock connection. */
  readonly run: (sql: string) => void;
  /** Closes the sidecar lock connection, releasing the hold. */
  readonly close: () => void;
}): Result<StoreLock, StoreLocked> {
  const held = Result.try({
    try: () => {
      options.run("PRAGMA busy_timeout = 0");
      options.run("BEGIN EXCLUSIVE");
    },
    catch: (cause) => new StoreLocked({ path: options.path, cause }),
  });
  if (held.isErr()) {
    options.close();
    return held;
  }
  return Result.ok({ release: options.close });
}
