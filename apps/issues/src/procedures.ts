import { labels, members, projects, teams } from "./procedures/catalog.js";
import { claimNumber } from "./procedures/numbering.js";
import * as reads from "./procedures/reads.js";
import { comments as commentWrites, history, issueLabels, reactions } from "./procedures/social.js";
import * as writes from "./procedures/writes.js";

/**
 * The tracker's API: every read and every write the app performs, and nothing else. A screen
 * names `api.issues.board({ teamId })`; Drizzle appears inside a handler and nowhere above one
 * (D26).
 *
 * Grouped by the noun a person would name, not by whether it reads or writes — `issues` holds
 * both `board` and `move`, because "the board" and "dragging a card on it" are one feature and
 * splitting them across two namespaces would only serve the implementation.
 *
 * Exactly one leaf here is an `.authority()` call (`issues.claimNumber`). Everything else runs
 * on the device, against local SQLite, with no network in it — which is the ordinary case and so
 * carries no marker. The exception is the one a reader has to notice, and it is the one that is
 * marked.
 */
export const issues = {
  list: reads.list,
  board: reads.board,
  get: reads.get,
  search: reads.search,
  counts: reads.counts,
  assigned: reads.assigned,
  summary: reads.summary,
  labelsOf: reads.labelsOf,
  labelTotals: reads.labelTotals,

  create: writes.create,
  edit: writes.edit,
  move: writes.move,
  setStatus: writes.setStatus,
  assign: writes.assign,
  view: writes.view,
  remove: writes.remove,

  claimNumber,
};

/** The thread and the three writes over it, in one place, because a UI treats them as one. */
export const comments = { forIssue: reads.thread, total: reads.threadCount, ...commentWrites };

export { history, issueLabels, labels, members, projects, reactions, teams };

/** What the app can do. `createApp` binds it to a mesh and a workspace; nothing here knows either. */
export const procedures = {
  issues,
  comments,
  reactions,
  issueLabels,
  history,
  teams,
  members,
  projects,
  labels,
};

export type Procedures = typeof procedures;
