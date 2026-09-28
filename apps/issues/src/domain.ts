import * as z from "zod";

/**
 * The vocabulary the whole app agrees on — declared once here, and read by the manifest (as
 * column checks), by the procedures (as input schemas) and by the seed. A status string that
 * only the input schema knew about would be a status a peer could still write.
 */

/**
 * The workspace this build's screens are about — **an input, never a construction argument.**
 *
 * The client is constructed knowing no workspace (book ch. 3): a scope id is ordinary data, and
 * data changes without reconstruction. So this is a value a screen passes into a call, the same
 * way it passes a team id, and the day this app grows a workspace switcher the only thing that
 * changes is where the value comes from — not how anything is built.
 */
export const WORKSPACE_ID = "acme";

/** The same workspace as the partition key a grant names: `kind:id`, one unit of custody. */
export const WORKSPACE = `workspace:${WORKSPACE_ID}` as const;

/**
 * Every procedure's input carries the workspace it is about; this is that, said once.
 *
 * A helper rather than a line repeated thirty-seven times, because thirty-seven chances to forget
 * it is thirty-seven calls that would quietly resolve to the global tables instead of failing.
 */
/* oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `ZodRawShape` is zod's own exported name for a field map; renaming it here would mean aliasing a library type to hide it */
export const scoped = <T extends z.ZodRawShape>(fields: T) =>
  z.object({ workspaceId: z.string().min(1), ...fields });

/**
 * An issue's state. Ordered as a board reads left to right, which is also the order a `CASE`
 * sorts by when a list is grouped rather than ranked.
 */
export const ISSUE_STATUS = ["triage", "backlog", "todo", "started", "done", "canceled"] as const;
export const IssueStatus = z.enum(ISSUE_STATUS);
export type IssueStatus = z.infer<typeof IssueStatus>;

/** The statuses a board shows as work in flight — what "my open issues" means. */
export const OPEN_STATUS = ["triage", "backlog", "todo", "started"] as const;

/**
 * Priority, ascending by urgency: 0 none … 4 urgent. An integer rather than a string so that
 * `ORDER BY priority DESC` is the sort a person means, with no lookup table in the SQL; the
 * names live in {@link PRIORITY_NAME} where a UI can read them.
 */
export const Priority = z.int().min(0).max(4);
export const PRIORITY_NAME = ["none", "low", "medium", "high", "urgent"] as const;

/** A project's state. Linear's set, minus the ones a tracker this size has no screen for. */
export const PROJECT_STATUS = ["planned", "started", "paused", "completed", "canceled"] as const;
export const ProjectStatus = z.enum(PROJECT_STATUS);

/**
 * What a history row records. `kind` plus `fromValue`/`toValue` rather than a sentence, so the
 * feed renders in the reader's language and a value that was renamed still reads correctly.
 */
export const ACTIVITY_KIND = [
  "created",
  "status",
  "priority",
  "assignee",
  "project",
  "estimate",
  "due",
  "title",
  "label",
  "numbered",
] as const;
export const ActivityKind = z.enum(ACTIVITY_KIND);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** What a reaction can hang off. Two tables' worth of rows in one, keyed by `(subject, subjectId)`. */
export const REACTION_SUBJECT = ["issue", "comment"] as const;
export const ReactionSubject = z.enum(REACTION_SUBJECT);

/** An id, as every procedure takes one: opaque text, non-empty, never parsed. */
export const Id = z.string().min(1);

/** `ENG-42`, or `ENG-•` for an issue an authority has not numbered yet. */
export const identifierOf = (teamKey: string, number: number | null): string =>
  `${teamKey}-${number === null ? "•" : number}`;
