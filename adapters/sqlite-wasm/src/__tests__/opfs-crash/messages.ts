import type { CrashMode } from "@syncmesh/storage/driver-tests";

/**
 * Pool slots for the suites: each store takes up to four (the log, the derived half and a WAL for
 * each), and the torn suite opens some thirty stores under one directory, so the default sixteen
 * would refuse the third copy with `SQLITE_CANTOPEN`.
 */
export const SLOTS = 256;

/**
 * What the suite page tells a writing worker: which database to write, how, and the
 * `BroadcastChannel` to say each committed sequence on — a channel rather than the worker's own
 * port, so a worker started by another page (the one the suite closes) reaches the suite too.
 */
export interface ChildOrder {
  readonly channel: string;
  readonly directory: string;
  readonly name: string;
  readonly mode: CrashMode;
}

/** What the file worker is asked to do to a database's log in the pool, by the store's name. */
export type FileOrder =
  | { readonly op: "copy"; readonly directory: string; readonly from: string; readonly to: string }
  | { readonly op: "size"; readonly directory: string; readonly name: string }
  | {
      readonly op: "zero";
      readonly directory: string;
      readonly name: string;
      readonly offset: number;
      readonly length: number;
    };

/** The file worker's answer: a size, nothing, or why it failed. */
export type FileAnswer = { readonly size: number } | { readonly failed: string };

/** An error and every cause under it, one per line: what a page says back across a port. */
export const told = (cause: unknown): string => {
  const lines: string[] = [];
  for (let at = cause; at !== undefined && at !== null;) {
    lines.push(at instanceof Error ? `${at.name}: ${at.message}` : JSON.stringify(at));
    at = at instanceof Error ? at.cause : undefined;
  }
  return lines.join("\n  caused by ");
};
