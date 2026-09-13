import { mutation } from "@syncmesh/orpc";
import { Temporal } from "@syncmesh/temporal";
import { asc, eq, sql } from "drizzle-orm";
import * as z from "zod";

import { Id, IssueStatus, Priority, scoped } from "../domain.js";
import { record } from "../history.js";
import { between } from "../rank.js";
import { issue } from "../tables.js";
import { at, atOrNull, parseInstant } from "../time.js";

/**
 * Every write to an issue.
 *
 * Each one takes an `actorId`. A handler cannot ask the mesh who is calling — the grant is
 * consulted by the rules, underneath, not handed to application code — so the caller states who
 * they are and the manifest is what makes the statement true or not: `owner("authorId")` on a
 * comment compares the row against the *signed* grant, and a device that names someone else is
 * refused by every receiver. Where no `owner` rule guards the column (an issue's `creatorId`),
 * the field is attribution rather than authority, and is treated as such.
 *
 * Every one also writes its history row in the same transaction, which is what makes the feed
 * and the issue one event rather than two that can arrive apart.
 */

const NewIssue = scoped({
  actorId: Id,
  teamId: Id,
  title: z.string().min(1).max(256),
  description: z.string().max(20_000).optional(),
  status: IssueStatus.optional(),
  priority: Priority.optional(),
  assigneeId: Id.nullable().optional(),
  projectId: Id.nullable().optional(),
  parentId: Id.nullable().optional(),
  estimate: z.int().min(0).max(21).nullable().optional(),
  dueDate: z.iso.datetime().nullable().optional(),
});

/**
 * Files an issue. It arrives with no `number`: the human `ENG-42` is minted by an authority
 * (`claimNumber`), and a tracker that refused to file an issue until it could reach one would be
 * useless on the train where issues are actually thought of.
 *
 * The rank puts it at the top of the list, which is where a person looks for the thing they just
 * typed — and computed from the current top rather than from a fixed constant, so two people
 * filing at once land next to each other instead of on top of each other.
 */
export const create = mutation.input(NewIssue).handler(async ({ input, mesh }) => {
  const now = Temporal.Now.instant();
  const [top] = await mesh.db
    .select({ rank: issue.rank })
    .from(issue)
    .where(eq(issue.teamId, input.teamId))
    .orderBy(asc(issue.rank), asc(issue.id))
    .limit(1);
  const id = crypto.randomUUID();
  await mesh.db.insert(issue).values({
    id,
    number: null,
    teamId: input.teamId,
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "triage",
    priority: input.priority ?? 0,
    assigneeId: input.assigneeId ?? null,
    creatorId: input.actorId,
    estimate: input.estimate ?? null,
    dueDate: input.dueDate == null ? null : at(parseInstant(input.dueDate)),
    rank: between(null, top?.rank ?? null),
    views: 0,
    createdAt: at(now),
    updatedAt: at(now),
    startedAt: null,
    completedAt: null,
  });
  await record(mesh, { issueId: id, actorId: input.actorId, kind: "created", when: now });
  return { id };
});

/** The fields a person edits in the detail panel. Only what was named is written. */
export const edit = mutation
  .input(
    scoped({
      id: Id,
      actorId: Id,
      title: z.string().min(1).max(256).optional(),
      description: z.string().max(20_000).optional(),
      priority: Priority.optional(),
      estimate: z.int().min(0).max(21).nullable().optional(),
      dueDate: z.iso.datetime().nullable().optional(),
      projectId: Id.nullable().optional(),
    }),
  )
  .handler(async ({ input, mesh }) => {
    const now = Temporal.Now.instant();
    const { id, actorId, dueDate, ...rest } = input;
    const patch = { ...rest, updatedAt: at(now) };
    if (dueDate !== undefined)
      Object.assign(patch, { dueDate: atOrNull(dueDate === null ? null : parseInstant(dueDate)) });
    await mesh.db.update(issue).set(patch).where(eq(issue.id, id));
    if (rest.title !== undefined)
      await record(mesh, { issueId: id, actorId, kind: "title", to: rest.title, when: now });
    if (rest.priority !== undefined)
      await record(mesh, {
        issueId: id,
        actorId,
        kind: "priority",
        to: String(rest.priority),
        when: now,
      });
    return { id };
  });

/**
 * Status and manual order in one write, because a drag across a board is one gesture. Splitting
 * them would leave a window in which the card is in the new column at the old rank — visible on
 * every other device, for as long as the second event takes to arrive.
 *
 * `previousId` and `nextId` are the neighbours the card was dropped between, as the UI already
 * knows them; `null` on either side is the end of the list. The handler reads their ranks rather
 * than trusting a rank from the client, so the key is computed against what *this* device
 * currently believes the order to be.
 */
export const move = mutation
  .input(
    scoped({
      id: Id,
      actorId: Id,
      status: IssueStatus.optional(),
      previousId: Id.nullable().optional(),
      nextId: Id.nullable().optional(),
    }),
  )
  .handler(async ({ input, mesh }) => {
    const now = Temporal.Now.instant();
    const rankOf = async (id: string | null) => {
      if (id === null) return null;
      const [row] = await mesh.db.select({ rank: issue.rank }).from(issue).where(eq(issue.id, id));
      return row?.rank ?? null;
    };
    const before = await rankOf(input.previousId ?? null);
    const after = await rankOf(input.nextId ?? null);
    const patch = { rank: between(before, after), updatedAt: at(now) };
    if (input.status !== undefined) Object.assign(patch, statusPatch(input.status, now));
    await mesh.db.update(issue).set(patch).where(eq(issue.id, input.id));
    if (input.status !== undefined)
      await record(mesh, {
        issueId: input.id,
        actorId: input.actorId,
        kind: "status",
        to: input.status,
        when: now,
      });
    return { id: input.id, rank: patch.rank };
  });

/** The timestamps a status change implies, so "when did this start" is a column and not a scan. */
const statusPatch = (status: IssueStatus, now: Temporal.Instant) => ({
  status,
  startedAt: status === "started" ? at(now) : null,
  completedAt: status === "done" || status === "canceled" ? at(now) : null,
});

/** Status on its own — the keyboard shortcut, as against the drag. */
export const setStatus = mutation
  .input(scoped({ id: Id, actorId: Id, status: IssueStatus }))
  .handler(async ({ input, mesh }) => {
    const now = Temporal.Now.instant();
    const [current] = await mesh.db
      .select({ status: issue.status })
      .from(issue)
      .where(eq(issue.id, input.id));
    await mesh.db
      .update(issue)
      .set({ ...statusPatch(input.status, now), updatedAt: at(now) })
      .where(eq(issue.id, input.id));
    await record(mesh, {
      issueId: input.id,
      actorId: input.actorId,
      kind: "status",
      from: current?.status ?? null,
      to: input.status,
      when: now,
    });
    return { id: input.id };
  });

/** Assignment, including unassignment — `null` is a value here, not an omission. */
export const assign = mutation
  .input(scoped({ id: Id, actorId: Id, assigneeId: Id.nullable() }))
  .handler(async ({ input, mesh }) => {
    const now = Temporal.Now.instant();
    const [current] = await mesh.db
      .select({ assigneeId: issue.assigneeId })
      .from(issue)
      .where(eq(issue.id, input.id));
    await mesh.db
      .update(issue)
      .set({ assigneeId: input.assigneeId, updatedAt: at(now) })
      .where(eq(issue.id, input.id));
    await record(mesh, {
      issueId: input.id,
      actorId: input.actorId,
      kind: "assignee",
      from: current?.assigneeId ?? null,
      to: input.assigneeId,
      when: now,
    });
    return { id: input.id };
  });

/**
 * Opening an issue counts as a view.
 *
 * The one column here that is not last-writer-wins. Written as plain SQL — `views + 1` — and
 * merged as a PN-counter, because the delta is what the engine captures, not the result: two
 * people opening the same issue on two planes have both opened it, and a column that kept only
 * the newer `1` would be quietly wrong in a way nobody ever notices.
 *
 * Reactions are *not* modelled this way, on purpose. A reaction has a name attached and can be
 * taken back, so it is a row; a view has neither, and a row per view is unbounded rubbish in a
 * log that replays forever. The test is whether the thing being counted has an identity.
 *
 * `updatedAt` is deliberately left alone: a view is not an edit, and bumping it would float every
 * issue anyone glanced at to the top of "recently updated".
 *
 * **What counts as an opening is the caller's to decide, and it is not "every mount".** This
 * procedure is the increment and nothing else — call it twice and the column moves twice, which is
 * what a counter is for. The screen coalesces to one view per issue per tab; `app/detail.tsx`'s
 * `counted` says why, and the number it replaced is why it says it at length.
 */
export const view = mutation.input(scoped({ id: Id })).handler(async ({ input, mesh }) => {
  await mesh.db
    .update(issue)
    .set({ views: sql`${issue.views} + 1` })
    .where(eq(issue.id, input.id));
  return { id: input.id };
});

/** Deleting an issue is an admin's; the manifest refuses it to anyone else. */
export const remove = mutation.input(scoped({ id: Id })).handler(async ({ input, mesh }) => {
  await mesh.db.delete(issue).where(eq(issue.id, input.id));
  return { id: input.id };
});
