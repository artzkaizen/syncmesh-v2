/**
 * The tracker's domain layer: what syncs, what can be asked of it, and a workspace to ask it of.
 *
 * No UI and no storage decision. The manifest names no driver, the procedures name no database
 * beyond Drizzle, and the seed takes a handle — so the same three files run over
 * `@syncmesh/sqlite-bun` in a test, over a browser driver in a tab, and over Postgres on an
 * authority, without any of them knowing which.
 */

export {
  issuesSchema,
  ISSUE_MEMBER_COLUMNS,
  type IssuesPresence,
  type IssuesSchema,
} from "./schema.js";
export {
  activity,
  comment,
  disclosure,
  issue,
  issueLabel,
  label,
  member,
  project,
  reaction,
  team,
} from "./tables.js";
export {
  ACTIVITY_KIND,
  ISSUE_STATUS,
  OPEN_STATUS,
  PRIORITY_NAME,
  PROJECT_STATUS,
  REACTION_SUBJECT,
  WORKSPACE,
  identifierOf,
  type ActivityKind,
  type IssueStatus,
} from "./domain.js";
export { procedures, type Procedures } from "./procedures.js";
export { authorityHandlers } from "./authority.js";
export { seedConversation, seedWorkspace, type SeedOptions, type SeededWorkspace } from "./seed.js";
export { FIRST_RANK, between, sequence } from "./rank.js";
export { at, atOrNull, instantOf, parseInstant } from "./time.js";
export { record, type Change } from "./history.js";
