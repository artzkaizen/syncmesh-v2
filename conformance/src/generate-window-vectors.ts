/**
 * Regenerates conformance/window-vectors.json. Run only when a window frame deliberately
 * changes (README rule 3): `bun conformance/src/generate-window-vectors.ts`.
 *
 * The three frames D43 adds above the relay's control tags: `desire` 32, `undesire` 33 and
 * `rows` 34, the last carrying E24's versioned patch.
 */
import type { ColumnName } from "@syncmesh/kernel";

import {
  WINDOW_TAGS,
  desireFrame,
  readKey,
  requestText,
  rowsFrame,
  undesireFrame,
} from "@syncmesh/window";
import { bytesToHex } from "@syncmesh/wire";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures: names the schema would own */
const SUBJECT = "subject" as ColumnName;
const AT = "at" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const INBOX = "mail.inbox";
const A = "m-1";
const B = "m-2";

const QUERY = requestText({ path: INBOX, input: { folder: "inbox", limit: 50 } });
/** What a row is held under: the read, its input's keys in order. */
const READ = readKey({ path: INBOX, input: { limit: 50, folder: "inbox" } });
const SCROLLED = requestText({
  path: INBOX,
  input: { folder: "inbox", limit: 50, after: { at: 150, id: "m-2" } },
});

const row = (subject: string, at: number) =>
  new Map<ColumnName, string | number>([
    [SUBJECT, subject],
    [AT, at],
  ]);

export function windowVectors() {
  const cases: readonly { description: string; kind: string; tag: number; wireHex: string }[] = [
    {
      description:
        "desire: a window id and its read, a query procedure's path and the input it was called with",
      kind: "desire",
      tag: WINDOW_TAGS.desire,
      wireHex: bytesToHex(desireFrame("inbox", QUERY)),
    },
    {
      description: "desire, the next page: the same id, the input naming the row to start after",
      kind: "desire",
      tag: WINDOW_TAGS.desire,
      wireHex: bytesToHex(desireFrame("inbox", SCROLLED)),
    },
    {
      description: "desire with since: a client after a gap, asking from where its stream stands",
      kind: "desire",
      tag: WINDOW_TAGS.desire,
      wireHex: bytesToHex(desireFrame("inbox", QUERY, { epoch: "e-7", version: 12 })),
    },
    {
      description: "undesire",
      kind: "undesire",
      tag: WINDOW_TAGS.undesire,
      wireHex: bytesToHex(undesireFrame("inbox")),
    },
    {
      description: "rows, a reset: a new epoch at version 1 carrying the whole view",
      kind: "rows",
      tag: WINDOW_TAGS.rows,
      wireHex: bytesToHex(
        rowsFrame({
          epoch: "e-8",
          version: 1,
          reset: true,
          puts: [
            { read: READ, key: B, row: row("invoice", 150) },
            { read: READ, key: A, row: row("hello", 120) },
          ],
          dels: [],
          windows: [{ id: "inbox", read: READ, keys: [B, A] }],
          refused: [],
          failed: [],
        }),
      ),
    },
    {
      description: "rows, a patch: version + 1, one row evicted, the window's new key list",
      kind: "rows",
      tag: WINDOW_TAGS.rows,
      wireHex: bytesToHex(
        rowsFrame({
          epoch: "e-8",
          version: 2,
          reset: false,
          puts: [],
          dels: [{ read: READ, key: A }],
          windows: [{ id: "inbox", read: READ, keys: [B] }],
          refused: [],
          failed: [],
        }),
      ),
    },
    {
      description: "rows, a refusal: the window was not opened, and why",
      kind: "rows",
      tag: WINDOW_TAGS.rows,
      wireHex: bytesToHex(
        rowsFrame({
          epoch: "e-8",
          version: 3,
          reset: false,
          puts: [],
          dels: [],
          windows: [],
          refused: [{ id: "drafts", reason: "no read mail.drafts" }],
          failed: [],
        }),
      ),
    },
    {
      description:
        "rows, a failure: the window's read did not run this time; it keeps its rows and is read again",
      kind: "rows",
      tag: WINDOW_TAGS.rows,
      wireHex: bytesToHex(
        rowsFrame({
          epoch: "e-8",
          version: 4,
          reset: false,
          puts: [],
          dels: [],
          windows: [],
          refused: [],
          failed: [{ id: "inbox", reason: "canceling statement due to statement timeout" }],
        }),
      ),
    },
  ];
  return { tags: { ...WINDOW_TAGS }, vectors: cases };
}

if (import.meta.main) {
  const out = new URL("../window-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(windowVectors(), null, 2)}\n`);
}
