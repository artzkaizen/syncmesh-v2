import type { Handle } from "@syncmesh/client";

import { Temporal } from "@syncmesh/temporal";

import { REMARKS } from "./seed-data.js";
import {
  commentRows,
  draftWith,
  feedRows,
  generator,
  issueRows,
  labelRows,
  memberRows,
  projectRows,
  reactionRows,
  tagRows,
  teamRows,
} from "./seed-rows.js";
import {
  activity,
  comment,
  issue,
  issueLabel,
  label,
  member,
  project,
  reaction,
  team,
} from "./tables.js";
import { at } from "./time.js";

/**
 * A workspace with enough in it to be worth looking at: three teams, twelve people, six
 * projects, a hundred and twenty issues with comments, labels, reactions and a history feed.
 *
 * **Deterministic.** Every id, title, assignee and timestamp comes out of one seeded generator,
 * so two runs produce byte-identical rows. That is not tidiness: a devtool showing the event log
 * is only readable if the log is the same every time, a screenshot diff is only meaningful if
 * the board is, and a convergence test that seeds two devices from the same number can compare
 * them row for row. `crypto.randomUUID()` would have cost all three.
 *
 * **Writes through the handle, never around it.** Every statement here goes through `mesh.db`,
 * so every row becomes an event exactly as a person's would. A seed that reached for raw SQL
 * would fill the tables and leave the log empty — which looks fine until the second device joins
 * and receives nothing.
 *
 * The handle must be granted `admin`: teams and labels are an admin's to create, and seeding is
 * an admin act.
 */
export interface SeedOptions {
  /** Fixes the generator. The same number is the same workspace, every time. */
  readonly seed?: number;
  /** How many issues to make. 120 is enough for a board that scrolls and a list that virtualises. */
  readonly issues?: number;
  /** The instant the workspace is seeded "now"; everything else is dated backwards from it. */
  readonly now?: Temporal.Instant;
  /**
   * The account this handle's grant names. Every comment and every reaction is attributed to it,
   * because the manifest will not let a device write either one as somebody else — and a fixture
   * is not an exception to that. {@link seedConversation} is how a demo gets more than one voice.
   */
  readonly as?: string;
}

/** What was made, by id, so a test or a devtool can ask about it without querying for it. */
export interface SeededWorkspace {
  readonly teamIds: Readonly<Record<string, string>>;
  readonly memberIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly projectIds: readonly string[];
  readonly issueIds: readonly string[];
}

const DEFAULT_NOW = Temporal.Instant.from("2026-09-01T09:00:00Z");
const DEFAULT_SEED = 20_260_901;
const BATCH = 40;

/** Inserts in batches: one statement per row would be a hundred and twenty events for a fixture. */
const insertAll = async <T>(
  run: (rows: T[]) => Promise<void>,
  rows: readonly T[],
): Promise<void> => {
  for (let from = 0; from < rows.length; from += BATCH) await run(rows.slice(from, from + BATCH));
};

export async function seedWorkspace(
  mesh: Handle,
  options: SeedOptions = {},
): Promise<SeededWorkspace> {
  const now = options.now ?? DEFAULT_NOW;
  const draft = draftWith(options.seed ?? DEFAULT_SEED, now, options.as ?? "acct_ada");

  const teams = teamRows();
  const teamIds = Object.fromEntries(teams.map((row) => [row.key, row.id]));
  const members = memberRows();
  const memberIds = members.map((row) => row.id);
  const labels = labelRows(teamIds);
  const projects = projectRows(draft, teamIds, memberIds);
  const issues = issueRows(draft, options.issues ?? 120, teamIds, projects, memberIds);
  const tags = tagRows(draft, issues, labels);
  const comments = commentRows(draft, issues);
  const reactions = reactionRows(draft, comments);
  const feed = feedRows(issues);

  // in dependency order, so a device receiving the events mid-stream never holds a row pointing
  // at one it has not folded yet for longer than a single batch
  await mesh.db.insert(team).values(teams);
  await mesh.db.insert(member).values(members);
  await mesh.db.insert(label).values(labels);
  await mesh.db.insert(project).values(projects);
  await insertAll(async (rows) => void (await mesh.db.insert(issue).values(rows)), issues);
  await insertAll(async (rows) => void (await mesh.db.insert(issueLabel).values(rows)), tags);
  await insertAll(async (rows) => void (await mesh.db.insert(comment).values(rows)), comments);
  await insertAll(async (rows) => void (await mesh.db.insert(reaction).values(rows)), reactions);
  await insertAll(async (rows) => void (await mesh.db.insert(activity).values(rows)), feed);

  return {
    teamIds,
    memberIds,
    labelIds: labels.map((row) => row.id),
    projectIds: projects.map((row) => row.id),
    issueIds: issues.map((row) => row.id),
  };
}

/**
 * A conversation in more than one voice.
 *
 * Every speaker is a real device with a real grant, because `comment.insert` is
 * `owner("authorId")` and there is no way around that — which is the rule working, not the rule
 * being awkward. The cost is visible here (a demo that wants twelve voices opens twelve meshes)
 * and it is the right cost: the alternative is a tracker where anyone may post as anyone.
 */
export async function seedConversation(
  speakers: readonly { readonly account: string; readonly mesh: Handle }[],
  issueIds: readonly string[],
  options: SeedOptions = {},
): Promise<number> {
  const random = generator(options.seed ?? 7_311);
  const now = options.now ?? DEFAULT_NOW;
  let written = 0;
  for (const [turn, speaker] of speakers.entries()) {
    const mine = issueIds.filter((_, index) => index % speakers.length === turn);
    const rows = mine.map((issueId, index) => ({
      id: `${issueId}:v${turn}`,
      issueId,
      authorId: speaker.account,
      body: REMARKS[Math.floor(random() * REMARKS.length)] ?? "",
      replyTo: null,
      createdAt: at(now.subtract({ minutes: index * 11 + turn })),
      editedAt: null,
    }));
    await insertAll(
      async (batch) => void (await speaker.mesh.db.insert(comment).values(batch)),
      rows,
    );
    written += rows.length;
  }
  return written;
}
