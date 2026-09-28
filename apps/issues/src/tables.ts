import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The tracker's tables, in Drizzle — declared once here and imported into the manifest by
 * `fromDrizzle`, so a column added to a table cannot be forgotten in the thing that syncs it.
 *
 * Ids are UUID text everywhere, including the ones a person recognises. Linear shows `ENG-42`
 * and LiveStore's clone stores that 42 as the primary key, computed client-side as
 * `max(id) + 1` — which is the one modelling mistake a local-first tracker cannot afford: two
 * people filing an issue on a plane both allocate 42 and one of them loses their issue at the
 * merge. Here the key is a UUID that never collides, and the human number is a separate,
 * nullable column an authority fills in ({@link issue}).
 */

/**
 * A time column: epoch milliseconds on the wire, a `Date` back through Drizzle, a
 * `Temporal.Instant` everywhere above it (`./time.ts` is the one place the two meet).
 *
 * Every "is it off?" here is a nullable one of these rather than a boolean — `archivedAt`, not
 * `archived`. The tombstone then carries *when* for free, which is what a UI wants to print and
 * what an audit wants to read; a boolean would have thrown that away to save four bytes. It also
 * keeps booleans out of the schema, which matters more than it should: SQLite has no boolean
 * type, so a captured `true` arrives at the fold as the integer 1.
 */
const when = () => integer({ mode: "timestamp_ms" });

/**
 * A team: `ENG`, `DES`, `OPS`. The prefix a person reads on every issue lives here rather than
 * being derived from the name, because renaming a team must not renumber its issues.
 */
export const team = sqliteTable("team", {
  id: text().primaryKey(),
  key: text().notNull(),
  name: text().notNull(),
  color: text().notNull(),
  archivedAt: when(),
});

/**
 * A person in the workspace. `id` is the account id a grant names, which is what makes
 * `owner("authorId")` in the manifest mean "the person who wrote it" rather than "some string
 * the client sent" — the rule compares the row's column against the signed grant, not the input.
 */
export const member = sqliteTable("member", {
  id: text().primaryKey(),
  name: text().notNull(),
  handle: text().notNull(),
  email: text().notNull(),
  avatarColor: text().notNull(),
  deactivatedAt: when(),
});

/** A project: a body of work a team runs for a quarter. Ordered by `rank`, like issues are. */
export const project = sqliteTable("project", {
  id: text().primaryKey(),
  teamId: text().notNull(),
  name: text().notNull(),
  summary: text().notNull(),
  status: text().notNull(),
  leadId: text(),
  targetDate: when(),
  rank: text().notNull(),
  archivedAt: when(),
});

/** A label. `teamId` null means the whole workspace may use it; set means one team owns it. */
export const label = sqliteTable("label", {
  id: text().primaryKey(),
  name: text().notNull(),
  color: text().notNull(),
  teamId: text(),
});

/**
 * The issue.
 *
 * `number` is nullable and no device writes it — see `issues.claimNumber`, the one call here
 * that needs an authority. Until it lands the UI shows `ENG-•`, which is an honest rendering of
 * "filed, not yet numbered" and is what a tracker on a train should say.
 *
 * `description` sits on the row rather than in a side table. LiveStore's clone splits it out so
 * board queries stay narrow; here a board query is local SQLite and a column it does not select
 * costs nothing, while the split would cost a second row to keep in step on every edit. What a
 * wide column does cost is event payload, and that is paid per *write* — which is exactly when
 * the description is the thing being written.
 *
 * `views` is a counter: see the manifest for why it is the one column here that is not
 * last-writer-wins.
 */
export const issue = sqliteTable("issue", {
  id: text().primaryKey(),
  number: integer(),
  teamId: text().notNull(),
  projectId: text(),
  parentId: text(),
  title: text().notNull(),
  description: text().notNull(),
  status: text().notNull(),
  priority: integer().notNull(),
  assigneeId: text(),
  creatorId: text().notNull(),
  estimate: integer(),
  dueDate: when(),
  rank: text().notNull(),
  views: integer().notNull(),
  createdAt: when().notNull(),
  updatedAt: when().notNull(),
  startedAt: when(),
  completedAt: when(),
});

/**
 * A label on an issue, as a row. A `labelIds` array column would be one cell, and one cell is
 * one last-writer-wins decision: two people labelling the same issue while apart would keep one
 * person's labels and silently drop the other's. A membership is a table (D25).
 */
export const issueLabel = sqliteTable("issuelabel", {
  id: text().primaryKey(),
  issueId: text().notNull(),
  labelId: text().notNull(),
  addedBy: text().notNull(),
  addedAt: when().notNull(),
});

/** A comment. `editedAt` null means never edited, which is also what the UI wants to know. */
export const comment = sqliteTable("comment", {
  id: text().primaryKey(),
  issueId: text().notNull(),
  authorId: text().notNull(),
  body: text().notNull(),
  replyTo: text(),
  createdAt: when().notNull(),
  editedAt: when(),
});

/**
 * One person's one emoji on one thing. A row per reaction rather than a tally column, because
 * the UI needs the names ("Ada and 3 others") and because a set of rows merges by itself: two
 * people reacting while apart produce two rows and neither is lost.
 */
export const reaction = sqliteTable("reaction", {
  id: text().primaryKey(),
  subject: text().notNull(),
  subjectId: text().notNull(),
  emoji: text().notNull(),
  actorId: text().notNull(),
  reactedAt: when().notNull(),
});

/**
 * The history feed, append-only. Derived facts — "status went todo → started" — written down
 * rather than reconstructed, because the log knows the *cells* that changed and a person wants
 * the *sentence*, and because a device that joined last week still has to render last month.
 */
export const activity = sqliteTable("activity", {
  id: text().primaryKey(),
  issueId: text().notNull(),
  actorId: text().notNull(),
  kind: text().notNull(),
  fromValue: text(),
  toValue: text(),
  at: when().notNull(),
});

/**
 * An embargoed security report, in its own sealed partition. Deliberately not joined to
 * anything here: it is another instance entirely, and the whole point is that nothing in the
 * workspace can reach across to it.
 */
export const disclosure = sqliteTable("disclosure", {
  id: text().primaryKey(),
  title: text().notNull(),
  body: text().notNull(),
  reporterId: text().notNull(),
  severity: text().notNull(),
  embargoUntil: when().notNull(),
  issueId: text(),
});
