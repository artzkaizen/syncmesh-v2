import { mutation, query } from "@syncmesh/orpc";
import { Temporal } from "@syncmesh/temporal";
import { and, asc, count, eq } from "drizzle-orm";
import * as z from "zod";

import { Id, ReactionSubject, scoped } from "../domain.js";
import { record } from "../history.js";
import { activity, comment, issueLabel, reaction } from "../tables.js";
import { at } from "../time.js";

/**
 * The conversation around an issue: comments, reactions, labels, and the history feed.
 *
 * Three of the four are membership tables rather than columns on the issue, and the reason is
 * the same each time. A `labelIds` array, a `reactions` JSON blob and a `comments` count are all
 * one cell, and one cell is one last-writer-wins decision: two people acting on the same issue
 * while apart would keep one of them and silently drop the other. A row per act keeps both,
 * merges with no rule at all, and is what D25 means by "lists, tags and memberships are tables".
 */

export const comments = {
  post: mutation
    .input(
      scoped({
        issueId: Id,
        authorId: Id,
        body: z.string().min(1).max(20_000),
        replyTo: Id.nullable().optional(),
      }),
    )
    .handler(async ({ input, db }) => {
      const id = crypto.randomUUID();
      await db.insert(comment).values({
        ...input,
        id,
        replyTo: input.replyTo ?? null,
        createdAt: at(Temporal.Now.instant()),
        editedAt: null,
      });
      return { id };
    }),

  /**
   * **A person may edit their own comment and nobody else's.** The rule is `owner("authorId")`
   * on `update`, and it is enforced against the row already stored — so this handler does not
   * check anything, and could not usefully: a check written here would run on the author's
   * device, where the author is who they say they are. The rule runs on every receiver.
   */
  edit: mutation
    .input(scoped({ id: Id, body: z.string().min(1).max(20_000) }))
    .handler(async ({ input, db }) => {
      await db
        .update(comment)
        .set({ body: input.body, editedAt: at(Temporal.Now.instant()) })
        .where(eq(comment.id, input.id));
      return { id: input.id };
    }),

  /** Widened where `update` is not: an admin moderates, which is a job, but never rewrites. */
  remove: mutation.input(scoped({ id: Id })).handler(async ({ input, db }) => {
    await db.delete(comment).where(eq(comment.id, input.id));
    return { id: input.id };
  }),
};

export const reactions = {
  /** Every reaction on a thing, so a UI can group them by emoji and name the people. */
  forSubject: query
    .input(scoped({ subject: ReactionSubject, subjectId: Id }))
    .handler(({ input, db }) =>
      db
        .select()
        .from(reaction)
        .where(and(eq(reaction.subject, input.subject), eq(reaction.subjectId, input.subjectId)))
        .orderBy(asc(reaction.reactedAt), asc(reaction.id)),
    ),

  /** The tally a card renders, without the names. Counted from the rows, never stored. */
  tally: query.input(scoped({ subject: ReactionSubject, subjectId: Id })).handler(({ input, db }) =>
    db
      .select({ emoji: reaction.emoji, total: count() })
      .from(reaction)
      .where(and(eq(reaction.subject, input.subject), eq(reaction.subjectId, input.subjectId)))
      .groupBy(reaction.emoji)
      .orderBy(asc(reaction.emoji)),
  ),

  /**
   * The id is derived from `(actor, subject, emoji)` rather than random, which makes reacting
   * idempotent for free: the same person tapping the same emoji twice writes the same key, and
   * the fold has nothing new to do. A random id would have produced two rows and a tally of two
   * for one person.
   */
  add: mutation
    .input(
      scoped({
        subject: ReactionSubject,
        subjectId: Id,
        emoji: z.string().min(1).max(16),
        actorId: Id,
      }),
    )
    .handler(async ({ input, db }) => {
      const id = reactionId(input);
      await db
        .insert(reaction)
        .values({ ...input, id, reactedAt: at(Temporal.Now.instant()) })
        .onConflictDoNothing();
      return { id };
    }),

  /** Taking it back. `owner("actorId")` on `delete`, so nobody removes anyone else's. */
  remove: mutation
    .input(
      scoped({
        subject: ReactionSubject,
        subjectId: Id,
        emoji: z.string().min(1).max(16),
        actorId: Id,
      }),
    )
    .handler(async ({ input, db }) => {
      const id = reactionId(input);
      await db.delete(reaction).where(eq(reaction.id, id));
      return { id };
    }),
};

/** One person, one emoji, one thing: the key, so reacting twice is one row. */
const reactionId = (of: {
  readonly actorId: string;
  readonly subject: string;
  readonly subjectId: string;
  readonly emoji: string;
}): string => `${of.actorId}:${of.subject}:${of.subjectId}:${of.emoji}`;

export const issueLabels = {
  /**
   * Every attachment in the workspace, in one read.
   *
   * `issues.labelsOf` is the same fact for one issue and is what a detail view wants; a *list*
   * wants it for every row at once, and asking the per-issue read once per card would be a
   * hundred subscriptions to draw one screen of chips. The whole table is a few hundred rows of
   * three short columns — smaller than the issues it decorates — so the cheap thing and the
   * correct thing are the same thing here.
   */
  list: query.input(scoped({})).handler(({ db, read }) => {
    const source = read(issueLabel);
    return db.select().from(source).orderBy(asc(source.issueId), asc(source.labelId));
  }),

  attach: mutation
    .input(scoped({ issueId: Id, labelId: Id, actorId: Id }))
    .handler(async ({ input, db }) => {
      const now = Temporal.Now.instant();
      const id = `${input.issueId}:${input.labelId}`;
      await db
        .insert(issueLabel)
        .values({
          id,
          issueId: input.issueId,
          labelId: input.labelId,
          addedBy: input.actorId,
          addedAt: at(now),
        })
        .onConflictDoNothing();
      await record(db, {
        issueId: input.issueId,
        actorId: input.actorId,
        kind: "label",
        to: input.labelId,
        when: now,
      });
      return { id };
    }),

  detach: mutation
    .input(scoped({ issueId: Id, labelId: Id, actorId: Id }))
    .handler(async ({ input, db }) => {
      const now = Temporal.Now.instant();
      await db.delete(issueLabel).where(eq(issueLabel.id, `${input.issueId}:${input.labelId}`));
      await record(db, {
        issueId: input.issueId,
        actorId: input.actorId,
        kind: "label",
        from: input.labelId,
        when: now,
      });
      return { id: `${input.issueId}:${input.labelId}` };
    }),
};

/**
 * The history feed. Read-only here and by the manifest: `activity` refuses update and delete
 * outright, so there is no procedure to offer for either.
 */
export const history = {
  forIssue: query
    .input(scoped({ issueId: Id, limit: z.int().min(1).max(200).optional() }))
    .handler(({ input, db }) =>
      db
        .select()
        .from(activity)
        .where(eq(activity.issueId, input.issueId))
        .orderBy(asc(activity.at), asc(activity.id))
        .limit(input.limit ?? 50),
    ),
};
