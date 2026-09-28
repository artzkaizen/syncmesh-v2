import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

import type {
  activity,
  comment,
  issue,
  issueLabel,
  label,
  member,
  project,
  team,
} from "./tables.js";

import { ISSUE_STATUS } from "./domain.js";
import { sequence } from "./rank.js";
import {
  ACTIONS,
  EMOJI,
  LABELS,
  PEOPLE,
  PROJECTS,
  REASONS,
  REMARKS,
  TEAMS,
  THINGS,
} from "./seed-data.js";
import { at } from "./time.js";

/**
 * The rows a seeded workspace is made of, built and nothing else — no handle, no database, no
 * events. Kept apart from `seed.ts` so that "what the fixture contains" and "how it reaches the
 * log" are two questions with two answers, and so the rows can be diffed in a test without one
 * being written anywhere.
 *
 * Every builder takes the same {@link Draft}: one seeded generator, shared, in declaration
 * order. That is what makes the whole workspace a pure function of the seed number — reorder two
 * calls below and every id after them changes, which is a property worth knowing about.
 */

export interface Draft {
  readonly random: () => number;
  readonly pick: <T>(from: readonly T[]) => T;
  readonly chance: (odds: number) => boolean;
  /** `days` before the fixture's "now"; negative reaches into the future, for a due date. */
  readonly ago: (days: number) => Date;
  /** The account every comment and reaction is attributed to; the manifest allows no other. */
  readonly speaker: string;
}

/** mulberry32: four lines, uniform enough for fixture data, and identical on every runtime. */
export const generator = (state: number) => () => {
  state = (state + 0x6d_2b_79_f5) | 0;
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
};

export const draftWith = (seed: number, now: Temporal.Instant, speaker: string): Draft => {
  const random = generator(seed);
  return {
    random,
    pick: (from) => from[Math.floor(random() * from.length)] ?? panic("seed: nothing to pick from"),
    chance: (odds) => random() < odds,
    ago: (days) => at(now.subtract({ hours: Math.round(days * 24) })),
    speaker,
  };
};

export const teamRows = (): (typeof team.$inferInsert)[] =>
  TEAMS.map(({ key, name, color }) => ({
    id: `team-${key.toLowerCase()}`,
    key,
    name,
    color,
    archivedAt: null,
  }));

export const memberRows = (): (typeof member.$inferInsert)[] =>
  PEOPLE.map(({ name, handle, color }) => ({
    id: `acct_${handle}`,
    name,
    handle,
    email: `${handle}@acme.test`,
    avatarColor: color,
    deactivatedAt: null,
  }));

export const labelRows = (
  teamIds: Readonly<Record<string, string>>,
): (typeof label.$inferInsert)[] =>
  LABELS.map(({ name, color, team: owner }) => ({
    id: `label-${name}`,
    name,
    color,
    teamId: owner === null ? null : (teamIds[owner] ?? null),
  }));

export const projectRows = (
  draft: Draft,
  teamIds: Readonly<Record<string, string>>,
  memberIds: readonly string[],
): (typeof project.$inferInsert)[] => {
  const ranks = sequence(PROJECTS.length);
  return PROJECTS.map((p, index) => ({
    id: `project-${index + 1}`,
    teamId: teamIds[p.team] ?? "",
    name: p.name,
    summary: `${p.name} — the quarter's work, tracked here.`,
    status: p.status,
    leadId: memberIds[index % memberIds.length] ?? null,
    targetDate: draft.ago(-30 - index * 10),
    rank: ranks[index] ?? "V",
    archivedAt: null,
  }));
};

export function issueRows(
  draft: Draft,
  total: number,
  teamIds: Readonly<Record<string, string>>,
  projects: readonly (typeof project.$inferInsert)[],
  memberIds: readonly string[],
): (typeof issue.$inferInsert)[] {
  const ranks = sequence(total);
  const { pick, chance, random, ago } = draft;
  return Array.from({ length: total }, (_, index) => {
    const owner = TEAMS[index % TEAMS.length] ?? TEAMS[0];
    const teamId = teamIds[owner.key] ?? "";
    const status = pick(ISSUE_STATUS);
    const age = 1 + Math.floor(random() * 90);
    const scoped = chance(0.55);
    const inTeam = projects.filter((p) => p.teamId === teamId);
    return {
      id: `issue-${String(index + 1).padStart(3, "0")}`,
      // every fourth issue is left waiting on an authority, which is what a devtool wants to see
      number: index % 4 === 3 ? null : Math.floor(index / TEAMS.length) + 1,
      teamId,
      projectId: scoped && inTeam.length > 0 ? (pick(inTeam).id ?? null) : null,
      parentId: null,
      title: `${pick(ACTIONS)} ${pick(THINGS)} ${pick(REASONS)}`,
      description: `${pick(REMARKS)}\n\n${pick(REMARKS)}`,
      status,
      priority: Math.floor(random() * 5),
      assigneeId: chance(0.72) ? pick(memberIds) : null,
      creatorId: pick(memberIds),
      estimate: chance(0.5) ? pick([1, 2, 3, 5, 8]) : null,
      dueDate: chance(0.25) ? ago(-(1 + Math.floor(random() * 40))) : null,
      rank: ranks[index] ?? "V",
      views: Math.floor(random() * 40),
      createdAt: ago(age),
      updatedAt: ago(Math.max(0, age - Math.floor(random() * age))),
      startedAt: status === "started" || status === "done" ? ago(age - 1) : null,
      completedAt: status === "done" || status === "canceled" ? ago(Math.max(1, age - 3)) : null,
    };
  });
}

export const tagRows = (
  draft: Draft,
  issues: readonly (typeof issue.$inferInsert)[],
  labels: readonly (typeof label.$inferInsert)[],
): (typeof issueLabel.$inferInsert)[] =>
  issues.flatMap((row) =>
    labels
      .filter((one) => (one.teamId === null || one.teamId === row.teamId) && draft.chance(0.16))
      .map((one) => ({
        id: `${row.id}:${one.id}`,
        issueId: row.id,
        labelId: one.id,
        addedBy: row.creatorId,
        addedAt: row.createdAt,
      })),
  );

export const commentRows = (
  draft: Draft,
  issues: readonly (typeof issue.$inferInsert)[],
): (typeof comment.$inferInsert)[] =>
  issues.flatMap((row) =>
    Array.from({ length: Math.floor(draft.random() * 4) }, (_, turn) => ({
      id: `${row.id}:c${turn}`,
      issueId: row.id,
      authorId: draft.speaker,
      body: draft.pick(REMARKS),
      replyTo: null,
      createdAt: new Date(row.createdAt.getTime() + (turn + 1) * 3_600_000 * 7),
      editedAt: null,
    })),
  );

/** One person reacts to one thing with one emoji once; the key says so, so duplicates collapse. */
export const reactionRows = (draft: Draft, comments: readonly (typeof comment.$inferInsert)[]) => {
  const drawn = comments
    .filter(() => draft.chance(0.35))
    .map((one) => {
      const emoji = draft.pick(EMOJI);
      return {
        id: `${draft.speaker}:comment:${one.id}:${emoji}`,
        subject: "comment",
        subjectId: one.id,
        emoji,
        actorId: draft.speaker,
        reactedAt: one.createdAt,
      };
    });
  return [...new Map(drawn.map((row) => [row.id, row])).values()];
};

/** The history every seeded issue already has: filed, assigned, moved out of triage. */
export const feedRows = (
  issues: readonly (typeof issue.$inferInsert)[],
): (typeof activity.$inferInsert)[] =>
  issues.flatMap((row) => {
    const line = (suffix: string, kind: string, from: string | null, to: string | null) => ({
      id: `${row.id}:${suffix}`,
      issueId: row.id,
      actorId: row.assigneeId ?? row.creatorId,
      kind,
      fromValue: from,
      toValue: to,
      at: row.updatedAt,
    });
    const assignee = row.assigneeId ?? null;
    return [
      { ...line("a0", "created", null, null), actorId: row.creatorId, at: row.createdAt },
      ...(assignee === null ? [] : [line("a1", "assignee", null, assignee)]),
      ...(row.status === "triage" ? [] : [line("a2", "status", "triage", row.status)]),
    ];
  });
