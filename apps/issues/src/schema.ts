import { fromDrizzle, ladder, syncSchema, t } from "@syncmesh/schema";

import { ActivityKind, IssueStatus, Priority, ProjectStatus, ReactionSubject } from "./domain.js";
import {
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

/**
 * The manifest: what syncs, which instance it hangs under, and who may do what to it.
 *
 * Columns are imported from the Drizzle tables rather than restated, and the two or three that
 * need more than a type — a status that must be one of six words, a counter — are overridden by
 * name. `fromDrizzle` warns about every `timestamp` column ("Drizzle hands back a Date"); the
 * warning is right and the bridge is `./time.ts`, so the handler swallows them rather than
 * printing the same known fact ten times at import.
 */
const columnsOf = <D extends Parameters<typeof fromDrizzle>[0]>(
  drizzle: D,
  options?: Parameters<typeof fromDrizzle<D>>[1],
) => fromDrizzle(drizzle, { ...options, onWarn: () => undefined });

const issueColumns = columnsOf(issue, { merge: { views: "counter" } });
const projectColumns = columnsOf(project);
const activityColumns = columnsOf(activity);
const reactionColumns = columnsOf(reaction);

/**
 * The columns a member may set on an issue — every one except `number`, which only an authority
 * decides. Named once because the `allow` rule and the update procedure must not disagree.
 */
export const ISSUE_MEMBER_COLUMNS = [
  "teamId",
  "projectId",
  "parentId",
  "title",
  "description",
  "status",
  "priority",
  "assigneeId",
  "creatorId",
  "estimate",
  "dueDate",
  "rank",
  "views",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
] as const;

/**
 * The tracker's data model.
 *
 * **The workspace is the unit of custody, and the only one.** Teams, projects and labels are
 * rows inside it, not partitions of their own, because partitions are what a device joins and
 * leaves: making a team a partition would mean that moving someone between teams is a resync
 * and that a query spanning two teams — "everything assigned to me" — is a query no handler can
 * write, since a handle is pinned to one instance. A workspace is the boundary people actually
 * cross rarely and the boundary an admin actually thinks in.
 *
 * **`embargo` nests under it and is sealed.** See {@link issuesSchema.sealed} below.
 *
 * The role ladder is senior-first: `role("member")` admits owners and admins too.
 */
export const issuesSchema = () =>
  syncSchema({
    partitions: { workspace: { embargo: {} } },
    roles: { workspace: ladder("owner", "admin", "member", "guest") },
    /**
     * Exactly one kind is sealed, and it is not the tracker.
     *
     * Sealing a workspace would be the easy gesture and the wrong trade. Everything a hosted
     * tracker is worth — the gapless issue number an authority mints, a nightly sweep that
     * moves stale issues back to triage, folding into Postgres so the org's BI tool can read
     * it, a correction when someone deletes a project they should not have — needs a server
     * that can *read*, and a sealed partition is precisely one no server can read. Paying that
     * for issues titled "fix the footer padding" buys nothing.
     *
     * An embargoed vulnerability report is the scope where the trade flips. There the operator
     * is in the threat model, the content is worth more than the tooling around it, and giving
     * up server-side judgment costs nothing because nobody wanted an automated sweep over it.
     * It is its own instance per embargo (`embargo:acme-2026-001`), so the key that ends is the
     * whole story: revoke it and the device carries the events and reads none of them.
     */
    sealed: ["embargo"],

    presence: {
      /**
       * Who is looking at this issue, and whether they are mid-sentence. Presence and not a
       * table: it is true for as long as a tab is open and false the moment a laptop lid
       * closes, and a fact with that shape must never enter a log that replays forever.
       */
      viewing: {
        partition: "workspace",
        of: { issueId: t.text(), typing: t.boolean() },
        ttlMs: 15_000,
      },
    },

    tables: {
      /** Only an admin shapes the workspace. A guest — a contractor on one project — reads. */
      team: {
        columns: columnsOf(team),
        partition: "workspace",
        allow: ({ role }) => ({ $default: role("admin"), read: role("guest") }),
      },

      /**
       * A person may edit their own profile row and nobody else's; an admin may edit anyone's
       * and is the only one who adds or removes people. `owner("id")` compares the row's key
       * against the signed grant's account, so "their own" is not something a client asserts.
       */
      member: {
        columns: columnsOf(member),
        partition: "workspace",
        allow: ({ any, owner, role }) => ({
          $default: role("admin"),
          read: role("guest"),
          update: any(owner("id"), role("admin")),
        }),
      },

      /**
       * Any member may make a project and move it along. **Deleting one is an admin's**: a
       * project is where a quarter of work hangs, and a delete that syncs to forty devices is
       * the one write here with no undo that a person can perform by hand.
       */
      project: {
        columns: { ...projectColumns, status: projectColumns.status.check(ProjectStatus) },
        partition: "workspace",
        allow: ({ role }) => ({
          $default: role("member"),
          read: role("guest"),
          delete: role("admin"),
        }),
      },

      label: {
        columns: columnsOf(label),
        partition: "workspace",
        allow: ({ role }) => ({
          $default: role("member"),
          read: role("guest"),
          delete: role("admin"),
        }),
      },

      /**
       * The `number` column is the authority's, and `patchOnly` is how that is said: a member's
       * update is admitted only when every column it touches is one of theirs, so a client that
       * hands itself `ENG-1` is refused by the same rule every receiving device runs. An admin
       * — which is what the authority acts as — is not narrowed, because it is the one that
       * numbers the issue.
       */
      issue: {
        columns: {
          ...issueColumns,
          status: issueColumns.status.check(IssueStatus),
          priority: issueColumns.priority.check(Priority),
        },
        partition: "workspace",
        allow: ({ all, any, patchOnly, role }) => ({
          $default: role("member"),
          read: role("guest"),
          update: any(role("admin"), all(role("member"), patchOnly(ISSUE_MEMBER_COLUMNS))),
          delete: role("admin"),
        }),
      },

      issuelabel: {
        columns: columnsOf(issueLabel),
        partition: "workspace",
        allow: ({ deny, role }) => ({
          $default: role("member"),
          read: role("guest"),
          update: deny, // a label is attached or detached; there is nothing on the row to edit
        }),
      },

      /**
       * **You may write your own comment and edit your own comment, and nobody else's.** An
       * admin may delete anyone's — moderation is a real job — but cannot rewrite what someone
       * said, which is why `update` is `owner` alone and only `delete` widens.
       *
       * `insert` is owner-guarded too, and that is the rule with teeth: it means no device can
       * put words in another person's mouth, and it means a fixture cannot either — see
       * `seedConversation`, which has to open a device per voice because of this line.
       */
      comment: {
        columns: columnsOf(comment),
        partition: "workspace",
        allow: ({ any, deny, owner, role }) => ({
          $default: deny,
          read: role("guest"),
          insert: owner("authorId"),
          update: owner("authorId"),
          delete: any(owner("authorId"), role("admin")),
        }),
      },

      /** You add and remove your own reaction. Editing one is meaningless, so it is refused. */
      reaction: {
        columns: { ...reactionColumns, subject: reactionColumns.subject.check(ReactionSubject) },
        partition: "workspace",
        allow: ({ deny, owner, role }) => ({
          $default: deny,
          read: role("guest"),
          insert: owner("actorId"),
          delete: owner("actorId"),
        }),
      },

      /**
       * History is appended and never touched again — the same shape an observation has in the
       * rounds example, for the same reason. `$default: deny` states the refusal first and the
       * two operations a history row actually has are the exceptions to it, so a fourth
       * operation invented later is denied by default rather than allowed by omission.
       */
      activity: {
        columns: { ...activityColumns, kind: activityColumns.kind.check(ActivityKind) },
        partition: "workspace",
        allow: ({ deny, role }) => ({
          $default: deny,
          read: role("guest"),
          insert: role("member"),
        }),
      },

      /** Inside the sealed kind. The roles are the workspace's, inherited down the tree. */
      disclosure: {
        columns: columnsOf(disclosure),
        partition: "embargo",
        allow: ({ role }) => ({ $default: role("admin") }),
      },
    },
  });

export type IssuesSchema = ReturnType<typeof issuesSchema>;

/**
 * The presence topics this manifest declares. A caller that writes down the type of its mesh or
 * its app needs this: `Mesh<"sqlite">` defaults to a manifest with no topics, and a mesh that has
 * one is not assignable to it.
 */
export type IssuesPresence = IssuesSchema["presenceOf"];
