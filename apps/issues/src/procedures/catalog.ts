import { mutation, query } from "@syncmesh/orpc";
import { Temporal } from "@syncmesh/temporal";
import { and, asc, count, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import * as z from "zod";

import { Id, OPEN_STATUS, ProjectStatus, scoped } from "../domain.js";
import { between } from "../rank.js";
import { issue, label, member, project, team } from "../tables.js";
import { at, atOrNull, parseInstant } from "../time.js";

/**
 * The things issues hang off: teams, people, projects, labels.
 *
 * All four are ordinary rows in the workspace partition rather than partitions of their own.
 * The manifest says why; the consequence to notice here is that every one of these queries is a
 * plain local read across the whole workspace, which is what makes a sidebar cheap.
 */

export const teams = {
  list: query
    .input(scoped({}))
    .handler(({ db }) =>
      db.select().from(team).where(isNull(team.archivedAt)).orderBy(asc(team.key)),
    ),

  /** Making a team is an admin's — the manifest's `$default: role("admin")` is the whole rule. */
  create: mutation
    .input(
      scoped({
        key: z.string().regex(/^[A-Z]{2,5}$/),
        name: z.string().min(1).max(80),
        color: z.string().min(1).max(16),
      }),
    )
    .handler(async ({ input, db }) => {
      const id = crypto.randomUUID();
      await db.insert(team).values({ ...input, id, archivedAt: null });
      return { id };
    }),

  /** Archived, not deleted: the issues keep their prefix, and the prefix keeps its meaning. */
  archive: mutation.input(scoped({ id: Id })).handler(async ({ input, db }) => {
    await db
      .update(team)
      .set({ archivedAt: at(Temporal.Now.instant()) })
      .where(eq(team.id, input.id));
    return { id: input.id };
  }),
};

export const members = {
  list: query
    .input(scoped({}))
    .handler(({ db }) =>
      db.select().from(member).where(isNull(member.deactivatedAt)).orderBy(asc(member.name)),
    ),

  /**
   * How much open work each person is carrying, as one grouped read.
   *
   * **A roster needs this and cannot get it by asking per person.** Twelve members is twelve
   * queries and twelve subscriptions that re-run on every fold; the same screen over a real
   * workspace is hundreds. One `GROUP BY` is a single live query whose result changes when the
   * issues do, which is also the only version that stays correct while somebody reassigns.
   *
   * Unassigned issues are left out rather than bucketed under a null key: "nobody" is not a member
   * and a roster has no row to put it on. `read(issue)` rather than the bare table, so a guest's
   * count reflects what a guest can see instead of quietly leaking totals through an aggregate.
   */
  workload: query.input(scoped({})).handler(({ db, read }) => {
    const source = read(issue);
    return db
      .select({ assigneeId: source.assigneeId, open: count() })
      .from(source)
      .where(and(inArray(source.status, [...OPEN_STATUS]), isNotNull(source.assigneeId)))
      .groupBy(source.assigneeId);
  }),

  /**
   * A person edits their own row. The rule is `any(owner("id"), role("admin"))`, so the `id` in
   * this input is checked against the caller's signed grant rather than taken on trust — which
   * is the difference between a permission and a convention.
   */
  rename: mutation
    .input(scoped({ id: Id, name: z.string().min(1).max(80) }))
    .handler(async ({ input, db }) => {
      await db.update(member).set({ name: input.name }).where(eq(member.id, input.id));
      return { id: input.id };
    }),

  invite: mutation
    .input(
      scoped({
        id: Id,
        name: z.string().min(1).max(80),
        handle: z.string().min(1).max(40),
        email: z.email(),
        avatarColor: z.string().min(1).max(16),
      }),
    )
    .handler(async ({ input, db }) => {
      await db.insert(member).values({ ...input, deactivatedAt: null });
      return { id: input.id };
    }),
};

export const projects = {
  list: query.input(scoped({ teamId: Id.optional() })).handler(({ input, db, read }) => {
    const source = read(project);
    return db
      .select()
      .from(source)
      .where(input.teamId === undefined ? undefined : eq(source.teamId, input.teamId))
      .orderBy(asc(source.rank), asc(source.id));
  }),

  create: mutation
    .input(
      scoped({
        teamId: Id,
        name: z.string().min(1).max(120),
        summary: z.string().max(2000).optional(),
        status: ProjectStatus.optional(),
        leadId: Id.nullable().optional(),
        targetDate: z.iso.datetime().nullable().optional(),
      }),
    )
    .handler(async ({ input, db }) => {
      const id = crypto.randomUUID();
      const [last] = await db
        .select({ rank: project.rank })
        .from(project)
        .orderBy(asc(project.rank), asc(project.id));
      await db.insert(project).values({
        id,
        teamId: input.teamId,
        name: input.name,
        summary: input.summary ?? "",
        status: input.status ?? "planned",
        leadId: input.leadId ?? null,
        targetDate: atOrNull(input.targetDate == null ? null : parseInstant(input.targetDate)),
        rank: between(last?.rank ?? null, null),
        archivedAt: null,
      });
      return { id };
    }),

  update: mutation
    .input(
      scoped({
        id: Id,
        name: z.string().min(1).max(120).optional(),
        summary: z.string().max(2000).optional(),
        status: ProjectStatus.optional(),
        leadId: Id.nullable().optional(),
      }),
    )
    .handler(async ({ input, db }) => {
      const { id, ...patch } = input;
      await db.update(project).set(patch).where(eq(project.id, id));
      return { id };
    }),

  /**
   * **Admin only, and the manifest is what says so.** A project is where a quarter of work
   * hangs; a delete that syncs to forty devices is the one write here a person can make by hand
   * with no way back. `api.projects.remove.can(input)` rehearses it against the same rules, so a
   * UI can grey the button out without keeping a second copy of the rule (book ch. 15).
   */
  remove: mutation.input(scoped({ id: Id })).handler(async ({ input, db }) => {
    await db.delete(project).where(eq(project.id, input.id));
    return { id: input.id };
  }),
};

export const labels = {
  /** A team's labels plus the workspace-wide ones, which is what a label picker shows. */
  list: query.input(scoped({ teamId: Id.optional() })).handler(({ input, db }) =>
    db
      .select()
      .from(label)
      .where(
        input.teamId === undefined
          ? undefined
          : or(isNull(label.teamId), eq(label.teamId, input.teamId)),
      )
      .orderBy(asc(label.name)),
  ),

  create: mutation
    .input(
      scoped({
        name: z.string().min(1).max(40),
        color: z.string().min(1).max(16),
        teamId: Id.nullable().optional(),
      }),
    )
    .handler(async ({ input, db }) => {
      const id = crypto.randomUUID();
      await db.insert(label).values({ ...input, id, teamId: input.teamId ?? null });
      return { id };
    }),

  remove: mutation.input(scoped({ id: Id })).handler(async ({ input, db }) => {
    await db.delete(label).where(eq(label.id, input.id));
    return { id: input.id };
  }),
};
