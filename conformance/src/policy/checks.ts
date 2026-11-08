/** The granted mesh's `check()` step and its `can` questions (gap U3): what #32 left unported. */
import type { Authors, Mesh, Step } from "./changes.js";

import { insert, update } from "./changes.js";
import { MEMBER } from "./schema.js";

/** A column's `check()`, run by a port as the JSON Schema the manifest carries for it (gap U3). */
export const checks = ({ by }: Authors): Step => ({
  description: "a column's check(), as the JSON Schema it says it accepts",
  events: [
    by(MEMBER, [
      insert("checked", "c1", { code: "ABC", qty: 3, email: "a@b.co", meta: { tag: "red" } }),
    ]),
    by(MEMBER, [insert("checked", "c2", { code: "abc", qty: 3 })]),
    by(MEMBER, [insert("checked", "c3", { code: "ABC", qty: 10 })]),
    by(MEMBER, [insert("checked", "c4", { code: "ABC", qty: 2.5 })]),
    by(MEMBER, [insert("checked", "c5", { code: "ABC", qty: 1, email: "not an address" })]),
    by(MEMBER, [insert("checked", "c6", { code: "ABC", qty: 1, meta: { tag: "green" } })]),
    by(MEMBER, [insert("checked", "c7", { code: "ABC", qty: 1, meta: { tag: "blue", n: "1" } })]),
    by(MEMBER, [insert("checked", "c8", { code: "XYZ", qty: 9, email: null, meta: null })]),
    // the i flag passes "AB", and "😀" is two UTF-16 units: the function takes each of them
    by(MEMBER, [
      insert("checked", "c9", { code: "ABC", qty: 1, folded: "AB", word: "😀", dotted: "😀" }),
    ]),
    by(MEMBER, [update("checked", "c1", { qty: 0 })]),
    by(MEMBER, [update("checked", "c1", { code: "QRS", meta: { tag: "blue", n: 2 } })]),
  ],
});

const member = { account: "acct_member", role: "member" };
const viewer = {
  account: "acct_viewer",
  role: "viewer",
  claims: { projects: ["p1", "p2"], permissions: { tasks: ["relabel"] }, team: "red" },
};
const admin = { account: "acct_admin", role: "admin" };

/** `can` against the manifest, and against an instance's synced `_policy` row. */
export const canCases: NonNullable<Mesh["can"]> = [
  { description: "a member may insert a note", principal: member, what: "notes.insert" },
  { description: "a viewer may not", principal: viewer, what: "notes.insert" },
  { description: "a viewer may read", principal: viewer, what: "notes.read" },
  {
    description: "an owner's update, by the row",
    principal: member,
    what: "notes.update",
    row: { ownerId: "acct_member" },
  },
  {
    description: "someone else's row is not the member's",
    principal: member,
    what: "notes.update",
    row: { ownerId: "acct_admin" },
  },
  { description: "replace is the admin's", principal: member, what: "notes.replace" },
  { description: "an admin may replace", principal: admin, what: "notes.replace" },
  {
    description: "with no replace rule, replace is judged as update",
    principal: member,
    what: "boards.replace",
  },
  {
    description: "the synced _policy for org:beta overrules the manifest",
    principal: viewer,
    what: "notes.update",
    partition: "org:beta",
  },
  {
    description: "an instance with no synced _policy reads the manifest",
    principal: viewer,
    what: "notes.update",
    partition: "org:acme",
  },
  {
    description: "a claim the rule names",
    principal: viewer,
    what: "tasks.update",
    row: { archived: false },
    patch: { label: "x" },
  },
  {
    description: "a patch confined to its columns",
    principal: member,
    what: "tasks.update",
    row: { archived: false },
    patch: { done: true },
  },
  {
    description: "the same patch on an archived row",
    principal: member,
    what: "tasks.update",
    row: { archived: true },
    patch: { done: true },
  },
  { description: "a custom operation", principal: admin, what: "tasks.archive" },
  { description: "a deny default", principal: member, what: "tasks.archive" },
  {
    description: "a ranked comparison",
    principal: member,
    what: "ranks.insert",
    patch: { score: 12 },
  },
  { description: "a global table is read by anyone", principal: member, what: "settings.read" },
  { description: "and written by nobody's rule", principal: admin, what: "settings.insert" },
  {
    description: "a user table is the account's to write",
    principal: member,
    what: "profiles.insert",
  },
  { description: "a local table is this device's", principal: member, what: "drafts.insert" },
  { description: "a table the manifest lacks", principal: admin, what: "nothing.read" },
  { description: "no principal, no answer but no", principal: null, what: "notes.read" },
];
