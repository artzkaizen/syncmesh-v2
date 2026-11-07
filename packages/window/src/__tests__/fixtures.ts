import type { ColumnName, Row, RowKey, TableName } from "@syncmesh/kernel";

import { encodeCbor } from "@syncmesh/wire";

import type { WindowQuery } from "../query.js";
import type { ClientViewOptions } from "../view.js";

import { createWindowClient } from "../client.js";
import { WINDOW_TAGS } from "../frames.js";
import { createMemoryRowSource } from "../source.js";
import { createClientView } from "../view.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
export const MAIL = "mail" as TableName;
export const AT = "at" as ColumnName;
export const FOLDER = "folder" as ColumnName;
/** A table no source in these tests holds. */
export const CALLS = "calls" as TableName;
export const SUBJECT = "subject" as ColumnName;
/** Mail at `at` is `m-<at>`, zero-padded so keys sort as the numbers do. */
export const mailKey = (at: number) => `m-${String(at).padStart(8, "0")}` as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const mail = (at: number, folder = "inbox"): Row =>
  new Map<ColumnName, string | number>([
    [AT, at],
    [FOLDER, folder],
    [SUBJECT, `subject ${at}`],
  ]);

/** Newest first by `at`. */
export const newest = (limit: number, over: Partial<WindowQuery> = {}): WindowQuery => ({
  table: MAIL,
  order: [[AT, "desc"]],
  limit,
  ...over,
});

/** A keyset bound just after the mail at `at`, under {@link newest}. */
export const after = (at: number) => ({ cells: [at], key: mailKey(at) });

/** A frame tagged `rows` whose body is not a patch. */
const GARBLED = encodeCbor([WINDOW_TAGS.rows, "garbled"]);

/**
 * `count` mails at 1..count in a memory source, one view over it and one thin client, joined by
 * a pipe that can lose the view's next frames on purpose.
 */
export function harness(count: number, options: Partial<ClientViewOptions> = {}) {
  const source = createMemoryRowSource();
  source.load(
    MAIL,
    Array.from({ length: count }, (_, i) => ({ key: mailKey(i + 1), row: mail(i + 1) })),
  );
  const client = createWindowClient();
  const frames: Uint8Array[] = [];
  /** What happens to the view's frame at each index instead of reaching the client whole. */
  const faults = new Map<number, "lose" | "garble">();
  const view = createClientView({
    source,
    send: (frame) => {
      const fault = faults.get(frames.length);
      frames.push(frame);
      if (fault === "garble") client.receive(GARBLED);
      else if (fault === undefined) client.receive(frame);
    },
    ...options,
  });
  client.attach((frame) => view.receive(frame));
  return {
    source,
    view,
    client,
    frames,
    /** The view's next `n` frames never reach the client. */
    loseNext: (n = 1) => {
      for (let i = 0; i < n; i++) faults.set(frames.length + i, "lose");
    },
    /**
     * Spoils the view's frames at these offsets from the next one: each is lost, or arrives as a
     * `rows` frame that does not read as one.
     */
    spoil: (fault: "lose" | "garble", ...offsets: number[]) => {
      for (const offset of offsets) faults.set(frames.length + offset, fault);
    },
  };
}

export const ats = (rows: readonly { readonly row: Row }[]) => rows.map((r) => r.row.get(AT));

/** `n` numbers counting down from `from`: the `at`s a newest-first window shows. */
export const down = (from: number, n: number) => Array.from({ length: n }, (_, i) => from - i);
