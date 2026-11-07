import type { ColumnName, JsonValue, Row } from "@syncmesh/kernel";

import type { WindowRow } from "../frames.js";
import type { ReadRequest } from "../request.js";
import type { ServerWindowsOptions } from "../server.js";
import type { MemoryPageSourceOptions } from "../testing.js";

import { createWindowClient } from "../client.js";
import { createServerWindows } from "../server.js";
import { createMemoryPageSource } from "../testing.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
export const AT = "at" as ColumnName;
export const FOLDER = "folder" as ColumnName;
export const SUBJECT = "subject" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
export const MAIL = "mail";
/** A table no read in these tests touches. */
export const CALLS = "calls";
/** Mail at `at` is `m-<at>`, zero-padded so keys sort as the numbers do. */
export const mailKey = (at: number) => `m-${String(at).padStart(8, "0")}`;

export const mail = (at: number, folder = "inbox"): Row =>
  new Map<ColumnName, string | number>([
    [AT, at],
    [FOLDER, folder],
    [SUBJECT, `subject ${at}`],
  ]);

/* oxlint-disable anti-slop/no-runtime-typeof -- a test read parses its own input */
const field = (input: JsonValue, name: string): JsonValue | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? // SAFETY: a JSON value that is an object and not an array is a JSON object
      (input as { readonly [key: string]: JsonValue })[name]
    : undefined;
/* oxlint-enable anti-slop/no-runtime-typeof */

const atOf = (row: WindowRow) => Number(row.row.get(AT));

/**
 * `mail.inbox`, as an app would write it: newest first, `limit` rows strictly after the `after`
 * mail, in one folder when the input names one.
 */
const inbox = (rows: readonly WindowRow[], input: JsonValue) => {
  const folder = field(input, "folder");
  const after = field(input, "after");
  return rows
    .filter((r) => folder === undefined || r.row.get(FOLDER) === folder)
    .filter((r) => after === undefined || atOf(r) < Number(after))
    .sort((a, b) => atOf(b) - atOf(a))
    .slice(0, Number(field(input, "limit")));
};

/** A call to `mail.inbox`. */
export const newest = (
  limit: number,
  over: { readonly folder?: string; readonly after?: number } = {},
): ReadRequest => ({ path: "mail.inbox", input: { limit, ...over } });

/**
 * `count` mails at 1..count in a memory source, one socket's server windows over it and one thin
 * client, joined by a pipe that can lose the server's next frames on purpose.
 */
export function harness(
  count: number,
  options: Partial<ServerWindowsOptions> & MemoryPageSourceOptions = {},
) {
  const { canRead, ...serving } = options;
  const source = createMemoryPageSource(
    { "mail.inbox": { table: MAIL, page: inbox } },
    canRead === undefined ? {} : { canRead },
  );
  source.load(
    MAIL,
    Array.from({ length: count }, (_, i) => ({ key: mailKey(i + 1), row: mail(i + 1) })),
  );
  const client = createWindowClient();
  const frames: Uint8Array[] = [];
  let lose = 0;
  const server = createServerWindows({
    source,
    send: (frame) => {
      frames.push(frame);
      if (lose > 0) lose--;
      else client.receive(frame);
    },
    ...serving,
  });
  client.attach((frame) => server.receive(frame));
  return {
    source,
    server,
    client,
    frames,
    /** The server's next `n` frames never reach the client. */
    loseNext: (n = 1) => {
      lose = n;
    },
  };
}

export const ats = (rows: readonly { readonly row: Row }[]) => rows.map((r) => r.row.get(AT));

/** `n` numbers counting down from `from`: the `at`s a newest-first window shows. */
export const down = (from: number, n: number) => Array.from({ length: n }, (_, i) => from - i);
