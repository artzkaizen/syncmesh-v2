import { useLiveQuery } from "@syncmesh/react";
import { useMemo, useState } from "react";

import type { ActivityRow, CommentRow } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { Avatar } from "./atoms.js";
import { useActor, useCatalog } from "./context.js";
import { mesh } from "./mesh.js";
import {
  BUTTON,
  CAPTION,
  COLOR,
  HAIRLINE,
  INPUT,
  RADIUS,
  SPACE,
  TEXT,
  ago,
  priorityName,
  statusStyle,
} from "./ui.js";

/**
 * The conversation under an issue: what people said, what they tapped, and what changed.
 *
 * All three are separate tables and separate live reads, and none of them is a column on the
 * issue. A comment count, a reactions blob and a `labelIds` array would each be one cell, and one
 * cell is one last-writer-wins decision — two people commenting from two planes would keep one
 * remark and silently lose the other. Rows merge by themselves, which is why the merge rule for
 * this entire panel is "there isn't one".
 */

/** The six emoji a tracker actually needs. A picker is a different feature with a different budget. */
const EMOJI = ["👍", "🎉", "👀", "🚀", "😄", "❤️"] as const;

function Reactions({ subjectId }: { readonly subjectId: string }) {
  const { api } = mesh;
  const actor = useActor().account;
  const tally = useLiveQuery(
    api.reactions.tally({ workspaceId: WORKSPACE_ID, subject: "comment", subjectId }),
  ).data;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {tally.map((row) => (
        <button
          key={row.emoji}
          onClick={() =>
            api.reactions.remove({
              workspaceId: WORKSPACE_ID,
              subject: "comment",
              subjectId,
              emoji: row.emoji,
              actorId: actor,
            })
          }
          style={{ ...BUTTON, borderRadius: RADIUS.pill, color: COLOR.text, padding: "1px 7px" }}
          title="Take it back"
          type="button"
        >
          {row.emoji} {row.total}
        </button>
      ))}
      <button
        onClick={() => setOpen(!open)}
        style={{ ...BUTTON, borderRadius: RADIUS.pill, padding: "1px 7px" }}
        type="button"
      >
        +
      </button>
      {open
        ? EMOJI.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                // the id is `(actor, subject, emoji)`, so tapping twice writes the same key and
                // the fold has nothing new to do — idempotent without a check
                api.reactions.add({
                  workspaceId: WORKSPACE_ID,
                  subject: "comment",
                  subjectId,
                  emoji,
                  actorId: actor,
                });
                setOpen(false);
              }}
              style={{ ...BUTTON, borderRadius: RADIUS.pill, padding: "1px 6px" }}
              type="button"
            >
              {emoji}
            </button>
          ))
        : null}
    </div>
  );
}

function Remark({ of }: { readonly of: CommentRow }) {
  const catalog = useCatalog();
  const author = catalog.member.get(of.authorId);
  return (
    <li style={{ display: "grid", gap: SPACE.sm, gridTemplateColumns: "auto 1fr" }}>
      <Avatar size={22} who={author} />
      <div style={{ display: "grid", gap: SPACE.xs, minWidth: 0 }}>
        <div style={{ alignItems: "baseline", display: "flex", gap: SPACE.sm }}>
          <span style={{ ...TEXT.sm, color: COLOR.text, fontWeight: 500 }}>
            {author?.name ?? of.authorId}
          </span>
          <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>{ago(of.createdAt)}</span>
          {of.editedAt === null ? null : (
            <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>edited</span>
          )}
        </div>
        <p style={{ ...TEXT.sm, color: COLOR.textDim, margin: 0, whiteSpace: "pre-wrap" }}>
          {of.body}
        </p>
        <Reactions subjectId={of.id} />
      </div>
    </li>
  );
}

/**
 * One history line as a sentence.
 *
 * The row stores `kind` plus the two raw values rather than a rendered string, so a label that
 * was renamed after the fact still reads correctly and a device that folded the event last month
 * renders it in today's vocabulary. That is the whole reason this function exists here rather
 * than in the writer.
 */
const text = (value: string | null): string => value ?? "";

/** A row's value as the name it stands for, or the raw value when nothing in the catalog claims it. */
const named = (value: string | null, of: (id: string) => string | undefined, missing: string) =>
  value === null ? missing : (of(value) ?? value);

function sentence(
  row: ActivityRow,
  member: (id: string) => string | undefined,
  label: (id: string) => string | undefined,
): string {
  switch (row.kind) {
    case "created":
      return "filed this issue";
    case "status":
      return `moved it to ${statusStyle(text(row.toValue)).label.toLowerCase()}`;
    case "priority":
      return `set priority to ${priorityName(Number(text(row.toValue)))}`;
    case "assignee":
      return row.toValue === null
        ? "unassigned it"
        : `assigned it to ${named(row.toValue, member, "nobody")}`;
    case "label":
      return row.toValue === null
        ? `removed ${named(row.fromValue, label, "a label")}`
        : `added ${named(row.toValue, label, "a label")}`;
    case "title":
      return `renamed it to "${text(row.toValue)}"`;
    case "numbered":
      return `numbered it ${text(row.toValue)}`;
    default:
      return `changed ${row.kind}`;
  }
}

function History({ issueId }: { readonly issueId: string }) {
  const { api } = mesh;
  const catalog = useCatalog();
  const rows = useLiveQuery(api.history.forIssue({ workspaceId: WORKSPACE_ID, issueId })).data;
  const name = (id: string) => catalog.member.get(id)?.name;
  const labelName = (id: string) => catalog.label.get(id)?.name;
  return (
    <ul style={{ display: "grid", gap: SPACE.xs, listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((row) => (
        <li key={row.id} style={{ ...TEXT.xs, color: COLOR.textFaint }}>
          <span style={{ color: COLOR.textDim }}>{named(row.actorId, name, "someone")}</span>{" "}
          {sentence(row, name, labelName)} · {ago(row.at)}
        </li>
      ))}
    </ul>
  );
}

/** The composer. `comment.insert` is `owner("authorId")`, so this tab can only ever speak as itself. */
function Composer({ issueId }: { readonly issueId: string }) {
  const { api } = mesh;
  const actor = useActor().account;
  const [body, setBody] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim() === "") return;
        api.comments.post({
          workspaceId: WORKSPACE_ID,
          issueId,
          authorId: actor,
          body: body.trim(),
        });
        setBody("");
      }}
      style={{ display: "grid", gap: SPACE.sm }}
    >
      <textarea
        onChange={(event) => setBody(event.target.value)}
        placeholder="Leave a comment…"
        rows={3}
        style={{ ...INPUT, resize: "vertical" }}
        value={body}
      />
      <button style={{ ...BUTTON, color: COLOR.text, justifySelf: "start" }} type="submit">
        Comment
      </button>
    </form>
  );
}

/** How many comments a thread opens on, and the step "Show earlier" adds. */
const SHOWN = 50;

/**
 * A thread: the newest {@link SHOWN}, oldest at the top, with the rest one click behind them.
 *
 * **A growing limit over `thread`'s descending order rather than its cursor**, and the difference
 * is that comments can be edited. A cursor hands back a page that was true when it was fetched;
 * a second page held beside the first is a second subscription that the first does not re-run,
 * so an edit to an older comment would sit stale on screen until something else re-read it. One
 * growing window is one subscription, and every row in it is live. The cursor stays on the
 * procedure for the reader that genuinely cannot hold the thread — and for `activity`, which is
 * append-only by the manifest and so has nothing to go stale.
 *
 * The query is newest-first because that is the end a thread pages from; the flip to reading
 * order happens here, once, rather than in the SQL where it would cost the index.
 */
export function Thread({ issueId }: { readonly issueId: string }) {
  const { api } = mesh;
  const [shown, setShown] = useState(SHOWN);
  const newestFirst = useLiveQuery(
    api.comments.forIssue({ workspaceId: WORKSPACE_ID, issueId, limit: shown }),
  ).data;
  const total = useLiveQuery(api.comments.total({ workspaceId: WORKSPACE_ID, issueId })).data[0]
    ?.total;
  const comments = useMemo(() => [...newestFirst].reverse(), [newestFirst]);
  // exact: the count is its own read with no LIMIT, so this is a subtraction and not a guess
  const earlier = total === undefined ? 0 : Math.max(0, total - comments.length);
  return (
    <div style={{ borderTop: HAIRLINE, display: "grid", gap: SPACE.lg, padding: SPACE.lg }}>
      <span style={CAPTION}>
        {total ?? comments.length} {(total ?? comments.length) === 1 ? "comment" : "comments"}
      </span>
      {earlier > 0 ? (
        <button
          onClick={() => setShown((held) => held + SHOWN)}
          style={{
            ...CAPTION,
            background: "none",
            border: "none",
            cursor: "pointer",
            justifySelf: "start",
            padding: 0,
          }}
          type="button"
        >
          Show {earlier.toLocaleString()} earlier
        </button>
      ) : undefined}
      <ul style={{ display: "grid", gap: SPACE.lg, listStyle: "none", margin: 0, padding: 0 }}>
        {comments.map((row) => (
          <Remark key={row.id} of={row} />
        ))}
      </ul>
      <Composer issueId={issueId} />
      <span style={CAPTION}>History</span>
      <History issueId={issueId} />
    </div>
  );
}
