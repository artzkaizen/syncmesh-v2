import type { StoredEvent } from "@syncmesh/engine";
import type {
  CellValue,
  Change,
  ColumnName,
  Logical,
  PartitionKey,
  PeerId,
  Procedure,
  RowKey,
  TableName,
} from "@syncmesh/kernel";

import { eventId, parsePartitionKey, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { panic } from "@syncmesh/result";
import { t, table } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";

/**
 * A Company OS-shaped tenant: five tables, many team partitions, many authors, and a log whose
 * mix is mostly activity and messages with a long tail of issues, contacts and deals. Generated
 * from a seed, so two runs at one size write the same bytes.
 *
 * One event carries {@link CHANGES_PER_EVENT} changes in one partition (one team's burst of
 * work), so ten million rows is a million events rather than ten million: the shape a server
 * sees when devices batch, and the one that keeps the run inside a night.
 */

export const TABLES = [
  table("issues", {
    id: t.text().primaryKey(),
    title: t.text(),
    body: t.text(),
    status: t.text(),
    priority: t.integer(),
    assignee: t.text(),
    created_at: t.integer(),
  }),
  table("messages", {
    id: t.text().primaryKey(),
    thread: t.text(),
    author: t.text(),
    body: t.text(),
    created_at: t.integer(),
  }),
  table("contacts", {
    id: t.text().primaryKey(),
    name: t.text(),
    email: t.text(),
    company: t.text(),
    created_at: t.integer(),
  }),
  table("deals", {
    id: t.text().primaryKey(),
    contact: t.text(),
    stage: t.text(),
    amount: t.integer(),
    won: t.boolean(),
    created_at: t.integer(),
  }),
  table("activity", {
    id: t.text().primaryKey(),
    kind: t.text(),
    subject: t.text(),
    actor: t.text(),
    created_at: t.integer(),
  }),
];

export const CHANGES_PER_EVENT = 10;

/**
 * What every event carries where a signature goes: never verified here (`join` measures that),
 * but present, as on every event a relay delivers. An unsigned event from another author is a
 * write this authority could never send, and boot reads every one of those back to say so.
 */
const SIGNED = new Uint8Array(64).fill(7);
export const AUTHORS = 16;

/** Cumulative weights over {@link TABLES}, in that order: activity and messages dominate. */
const MIX = [
  ["issues", 0.12],
  ["messages", 0.42],
  ["contacts", 0.5],
  ["deals", 0.55],
  ["activity", 1],
] as const;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- bench fixtures; naming rules are not what is measured */
const name = (value: string) => value as TableName;
const col = (value: string) => value as ColumnName;
const PROCEDURE = "tenant.write" as Procedure;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** mulberry32: small, fast, and the same sequence on every runtime. */
export const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
const STAGES = ["lead", "qualified", "proposal", "negotiation", "closed"];
const KINDS = ["comment", "status", "assign", "mention", "upload", "view"];
const WORDS =
  "the a quarterly plan review onboarding customer invoice roadmap launch follow-up contract renewal bug fix design meeting hiring budget".split(
    " ",
  );

export const partitionsOf = (count: number): readonly PartitionKey[] =>
  Array.from({ length: count }, (_, i) => parsePartitionKey(`workspace:team${i}`).unwrap());

export const authorsOf = (): readonly PeerId[] =>
  Array.from({ length: AUTHORS }, (_, i) =>
    parsePeerId(i.toString(16).padStart(2, "0").repeat(32)).unwrap(),
  );

export interface Tenant {
  readonly partitions: readonly PartitionKey[];
  readonly authors: readonly PeerId[];
  /** How many rows `table` has had inserted in team `team`; its ids are `<table>-<team>-1` through `-<n>`. */
  readonly inserted: (table: string, team: number) => number;
  /** The next `count` events of the log; inserts until `inserted` reaches the target, then whatever is asked. */
  readonly events: (count: number, mode: "insert" | "mixed") => readonly StoredEvent[];
  readonly rowsInserted: () => number;
}

/** A tenant's generator. Every call continues the same log: sequence numbers, clock and ids. */
export function tenant(options: { readonly partitions: number; readonly seed: number }): Tenant {
  const random = seeded(options.seed);
  const partitions = partitionsOf(options.partitions);
  const authors = authorsOf();
  const seqs = authors.map(() => 0);
  // per table, per team: a row lives in the team its event was written in, and stays there
  const counters = new Map<string, number[]>(TABLES.map((x) => [x.name, partitions.map(() => 0)]));
  let clock = 1_750_000_000_000;
  let next = 0;
  let inserted = 0;

  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)] ?? panic("picked from an empty list");
  const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

  const rowFor = (tableName: string, id: string, at: number): Map<ColumnName, CellValue> => {
    const cells: [string, CellValue][] = [["id", id]];
    if (tableName === "issues")
      cells.push(
        ["title", words(6)],
        ["body", words(40)],
        ["status", pick(STATUSES)],
        ["priority", Math.floor(random() * 4)],
        ["assignee", `user${Math.floor(random() * 500)}`],
      );
    else if (tableName === "messages")
      cells.push(
        ["thread", `thread${Math.floor(random() * 50_000)}`],
        ["author", `user${Math.floor(random() * 500)}`],
        ["body", words(20)],
      );
    else if (tableName === "contacts")
      cells.push(
        ["name", `${pick(WORDS)} ${pick(WORDS)}`],
        ["email", `${id}@example.com`],
        ["company", `company${Math.floor(random() * 5_000)}`],
      );
    else if (tableName === "deals")
      cells.push(
        ["contact", `contacts-${Math.floor(random() * 100_000)}`],
        ["stage", pick(STAGES)],
        ["amount", Math.floor(random() * 1_000_000)],
        ["won", random() < 0.3],
      );
    else
      cells.push(
        ["kind", pick(KINDS)],
        ["subject", `issues-${Math.floor(random() * 100_000)}`],
        ["actor", `user${Math.floor(random() * 500)}`],
      );
    cells.push(["created_at", at]);
    return new Map(cells.map(([k, v]) => [col(k), v]));
  };

  const tableFor = (): string => {
    const roll = random();
    return (MIX.find(([, upTo]) => roll < upTo) ?? panic("the mix ends at 1"))[0];
  };

  const change = (mode: "insert" | "mixed", team: number, at: number): Change => {
    const tableName = tableFor();
    const perTeam = counters.get(tableName) ?? panic("every table has its counters");
    const live = perTeam[team] ?? 0;
    if (mode === "mixed" && live > 0 && random() < 0.7) {
      // an update: one or two columns of a row this team already wrote, as edits are
      const id = `${tableName}-${team}-${1 + Math.floor(random() * live)}`;
      const whole = rowFor(tableName, id, at);
      const patch = new Map(
        [...whole].filter(([k]) => k !== col("id") && k !== col("created_at")).slice(0, 2),
      );
      // SAFETY: ids are `<table>-<team>-<n>`, built just below
      return { kind: "update", table: name(tableName), key: id as RowKey, patch };
    }
    perTeam[team] = live + 1;
    const id = `${tableName}-${team}-${live + 1}`;
    inserted += 1;
    // SAFETY: as above
    return {
      kind: "insert",
      table: name(tableName),
      key: id as RowKey,
      row: rowFor(tableName, id, at),
    };
  };

  const events = (count: number, mode: "insert" | "mixed"): readonly StoredEvent[] =>
    Array.from({ length: count }, () => {
      next += 1;
      clock += 1;
      const index = next % AUTHORS;
      const author = authors[index] ?? panic("the author list is fixed");
      seqs[index] = (seqs[index] ?? 0) + 1;
      const seqNum = parseSeqNum(seqs[index] ?? 0).unwrap();
      const team = Math.floor(random() * partitions.length);
      return {
        event: {
          v: 1,
          id: eventId(author, seqNum),
          peerId: author,
          seqNum,
          hlc: [Temporal.Instant.fromEpochMilliseconds(clock), ZERO],
          procedure: PROCEDURE,
          changes: Array.from({ length: CHANGES_PER_EVENT }, () => change(mode, team, clock)),
          partition: partitions[team] ?? panic("the team was drawn from the list"),
        },
        sig: SIGNED,
      };
    });

  return {
    partitions,
    authors,
    inserted: (tableName, team) => counters.get(tableName)?.[team] ?? 0,
    events,
    rowsInserted: () => inserted,
  };
}
