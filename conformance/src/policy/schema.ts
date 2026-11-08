/**
 * The policy vectors' fixtures (gap U3): who writes, where, and the manifest every rung of the
 * ladder has a table in. Fixed seeds, so every signature is deterministic.
 */
import type {
  ColumnName,
  DocColumns,
  PartitionKey,
  Procedure,
  RowKey,
  TableName,
} from "@syncmesh/kernel";

import { parseAdapterId } from "@syncmesh/kernel";
import { flat, from, ladder, local, partition, syncSchema, t, user } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";

export const NOW_MS = 1_700_000_000_000;
export const NOW = Temporal.Instant.fromEpochMilliseconds(NOW_MS);
export const MINUTE = 60_000;

const seed = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => (start + i) % 256);
export const ISSUER = createIdentity(seed(1)).unwrap();
export const AUTHORITY = createIdentity(seed(33)).unwrap();
export const DEVICE = createIdentity(seed(65)).unwrap();
export const ADMIN = createIdentity(seed(97)).unwrap();
export const MEMBER = createIdentity(seed(129)).unwrap();
export const VIEWER = createIdentity(seed(161)).unwrap();
export const STRANGER = createIdentity(seed(193)).unwrap();
export const OUTSIDER = createIdentity(seed(225)).unwrap();
export const REVOKED = createIdentity(seed(17)).unwrap();
export const LEAD = createIdentity(seed(49)).unwrap();
export const ACCOUNT = createIdentity(seed(81)).unwrap();
export const LINKED = createIdentity(seed(113)).unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed vector names; the schema below owns their rules */
export const name = <T>(s: string) => s as T;
export const table = (s: string) => name<TableName>(s);
export const key = (s: string) => name<RowKey>(s);
export const column = (s: string) => name<ColumnName>(s);
export const part = (s: string) => name<PartitionKey>(s);
export const procedure = (s: string) => name<Procedure>(s);
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const ACME = part("org:acme");
export const BETA = part("org:beta");
export const GAMMA = part("org:gamma");
export const STRICT = part("org:strict");
export const TEAM = part("team:t1");
export const LORO = parseAdapterId("loro@1").unwrap();

const org = partition("org", { roles: ladder("admin", "member", "viewer") });
const team = partition("team", { roles: flat("lead", "ops") });

/** Every rung of the ladder has a table here that reaches it. */
export const policySchema = syncSchema({
  dropped: ["oldnotes"],
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        body: t.text().nullable(),
        ownerId: t.text(),
        content: t.blob({ merge: { id: "loro@1" } }).nullable(),
        summary: t.text().nullable(),
        legacy: t.text().nullable().retired(),
      },
      partition: org,
      derive: { summary: from("content", (doc: string) => doc) },
      // editing is the owner's or an admin's; starting a new lineage is an admin's alone
      allow: ({ role, owner, any }) => ({
        $default: role("admin"),
        read: role("viewer"),
        insert: role("member"),
        update: any(owner("ownerId"), role("admin")),
        replace: role("admin"),
      }),
    },
    boards: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        content: t.blob({ merge: { id: "loro@1" } }).nullable(),
      },
      partition: org,
      // no replace rule: a genesis is judged as the update it otherwise is
      allow: ({ role }) => ({
        $default: role("admin"),
        insert: role("member"),
        update: role("member"),
      }),
    },
    tasks: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        done: t.boolean(),
        points: t.integer().nullable(),
        weight: t.float().nullable(),
        due: t.timestamp().nullable(),
        label: t.text().nullable(),
        projectId: t.text().nullable(),
        archived: t.boolean().nullable(),
        ref: t.uuid().nullable(),
        meta: t.json().nullable(),
        votes: t.integer({ merge: "counter" }).nullable(),
      },
      partition: org,
      allow: ({ deny, role, claim, can, rowIs, patchOnly, any, all, not }) => ({
        $default: deny,
        insert: any(
          role("member"),
          claim("projects").has("projectId"),
          claim("team").equals("label"),
        ),
        update: any(
          role("admin"),
          all(patchOnly(["done", "points", "votes"]), not(rowIs({ archived: true }))),
          all(patchOnly(["label"]), can("tasks", "relabel")),
        ),
        delete: all(
          role("member"),
          { kind: "isIn", column: "label", values: ["junk", "dup"] },
          { kind: "compare", column: "points", op: "lt", value: 3 },
        ),
        archive: role("admin"),
      }),
    },
    ranks: {
      columns: { id: t.text().primaryKey(), title: t.text(), score: t.integer().nullable() },
      partition: org,
      allow: ({ all, any, role }) => ({
        $default: role("admin"),
        // ordered by UTF-16 code units, as JavaScript orders strings: "\u{1F600}" sorts below "\uFF00"
        insert: any(
          { kind: "compare", column: "score", op: "gte", value: 10 },
          all(
            { kind: "compare", column: "title", op: "gt", value: "m" },
            { kind: "compare", column: "title", op: "lt", value: "\uFF00" },
          ),
        ),
        update: { kind: "compare", column: "title", op: "ne", value: "locked" },
      }),
    },
    shifts: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: team,
      // a flat set: a lead is not an ops, and nobody outranks anybody
      allow: ({ role }) => ({ $default: role("lead"), insert: role("ops") }),
    },
    archive: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      retired: true,
      allow: ({ allow }) => ({ $default: allow }),
    },
    settings: { columns: { id: t.text().primaryKey(), value: t.text() } },
    profiles: { columns: { id: t.text().primaryKey(), name: t.text() }, partition: user },
    drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local },
    feed: { columns: { id: t.text().primaryKey(), line: t.text() }, visibility: "authority" },
  },
});

/** The schema's document columns, keyed the way the validator and the fold key them. */
export const docs: DocColumns = new Map(
  [...policySchema.docs].map(([name, entries]) => [
    name,
    new Map(entries.map((entry) => [entry.column, parseAdapterId(entry.doc).unwrap()])),
  ]),
);
