import type { PartitionKey } from "@syncmesh/kernel";
import type { Change, Hlc, PeerId, Row, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";
import type { TableState } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { Grant } from "@syncmesh/wire";

import {
  evaluate,
  resolveAllow,
  type AllowBlock,
  type Operation,
  type PolicyContext,
  type PolicyGrant,
} from "@syncmesh/policy";
import { Result } from "@syncmesh/result";
import { checkRow, type Table } from "@syncmesh/schema";

import { checkLink } from "./accounts.js";
import { checkAuthor } from "./author.js";
import { RESERVED_AUTHOR_CLASS, UNPINNED_RESERVED, RESERVED_TABLE_NAMES } from "./authority.js";
import {
  LocalOnly,
  PartitionNotGranted,
  PolicyDenied,
  ReadOnlyPartition,
  SchemaViolation,
  UnknownTable,
  WrongPartition,
  type ValidationError,
} from "./errors.js";
import { syncedRules } from "./rules.js";

/** What validation needs from a schema, structurally, so any concrete `Schema<P, R, C>` fits. */
export interface ValidatorSchema {
  readonly entries: readonly {
    readonly table: Table;
    readonly partition: string;
    readonly visibility: "partition" | "authority";
    readonly allow?: AllowBlock;
  }[];
  rolesFor(kind: string): readonly string[];
  /** The manifest's own tables (`_policy`, `_corrections`); absent, they cannot be written at all. */
  readonly reserved?: readonly Table[];
}

/**
 * The event before it has a sequence number: everything validation reads. A probe carries no
 * `hlc` because it has not been stamped yet — which reads as "now", the only honest answer for
 * a write that has not happened.
 */
export type ProbeEvent = Pick<SyncEvent, "peerId" | "partition" | "changes" | "local"> & {
  readonly hlc?: Hlc;
};

/** The row a change applies to, as the device holds it; `undefined` when absent. */
export type RowLookup = (table: TableName, key: RowKey) => Row | undefined;

/** What the device holds about the rows an event touches. */
export interface StateLookup {
  readonly row: RowLookup;
  /**
   * Every record in a table, as the device holds it. The one reader that needs more than a key:
   * a fact filed under its own digest cannot be fetched by name, so resolving one is a fold over
   * the set. The map identity is stable until the table changes, which is what lets that fold be
   * remembered rather than repeated (see `accounts.ts`).
   *
   * Optional because most callers never need it, and a lookup that cannot enumerate simply
   * resolves no links — which is the same verdict a mesh with `accounts` off already reaches.
   */
  readonly records?: (table: TableName) => TableState | undefined;
  /** The partition the row was first written in; `undefined` when absent or unpartitioned. */
  readonly partition: (table: TableName, key: RowKey) => PartitionKey | undefined;
}

export interface ValidatorOptions {
  readonly schema: ValidatorSchema;
  /** `null` is ungranted mode: grant and policy steps are skipped; schema never is. */
  readonly grantFor: ((peer: PeerId) => Grant | undefined) | null;
  /** This process evaluates `visibility: "authority"` rules (the server peer); devices skip them. Never gates global writes — `authority` does. */
  readonly isAuthority?: boolean;
  /** The one peer whose events may write `global` tables; named like the issuer is, checked against the event's author. Absent, global tables are read-only everywhere. */
  readonly authority?: PeerId;
  /** Reads the wall clock for the grace rung. Absent, a partition's grace window is not applied at all — a validator with no clock never starts refusing what it used to admit. */
  readonly now?: () => Temporal.Instant;
  /**
   * Resolves an author to the account a `_links` row binds it to, where no grant is held (D21).
   * Absent, links are not consulted at all — the same shape `now` has, and shipped config on
   * every peer like `issuer` and `authority` is, never a capability: a peer's verdict may not
   * depend on which keys it happens to hold. Rollout is one-way, since accounts-off admits
   * strictly more and never less.
   */
  readonly accounts?: boolean;
}

export interface Validator {
  /** Ladder: grant → device → revocation → grace → partition → schema → policy. The first failure is the verdict. */
  readonly validate: (event: ProbeEvent, before: StateLookup) => Result<void, ValidationError>;
}

const RESERVED = new Set(["global", "user", "local"]);

export function createValidator(options: ValidatorOptions): Validator {
  const { schema, isAuthority = false, authority } = options;
  const entries = new Map(schema.entries.map((e) => [String(e.table.name), e]));
  const reserved = new Map((schema.reserved ?? []).map((t) => [String(t.name), t]));

  const validate: Validator["validate"] = (event, before) => {
    const verdict = checkAuthor(event, before, options);
    if (verdict.isErr()) return verdict;
    const author = verdict.value;
    for (const change of event.changes) {
      const table = String(change.table);
      if (RESERVED_TABLE_NAMES.has(table)) {
        const reservedVerdict = checkReserved(table, change, event, reserved, authority);
        if (reservedVerdict.isErr()) return reservedVerdict;
        continue;
      }
      const entry = entries.get(table);
      if (entry === undefined)
        return Result.err(new UnknownTable({ table, message: "not in the schema" }));
      const partition = checkPartition(table, entry, event, author, authority);
      if (partition.isErr()) return partition;
      const held = before.partition(change.table, change.key);
      if (held !== undefined && held !== event.partition) {
        return Result.err(
          new WrongPartition({ table, expected: held, message: `the row belongs to ${held}` }),
        );
      }
      const columns = checkColumns(entry.table, change);
      if (columns.isErr()) return columns;
      const rules = syncedRules(entry.table.name, event.partition, before.row) ?? entry.allow;
      const policy = checkPolicy(entry, rules, change, author, before.row, isAuthority, schema);
      if (policy.isErr()) return policy;
    }
    return Result.ok(undefined);
  };

  return { validate };
}

type Entry = ValidatorSchema["entries"][number];

function checkPartition(
  table: string,
  entry: Entry,
  event: ProbeEvent,
  author: Author | undefined,
  authority: PeerId | undefined,
): Result<void, ValidationError> {
  const kind = entry.partition;
  if (entry.visibility === "authority") return Result.ok(undefined);
  if (kind === "local") {
    return event.local === true
      ? Result.ok(undefined)
      : Result.err(new LocalOnly({ table, message: "a local table never travels" }));
  }
  if (kind === "global") {
    // authorship, never a local flag: the same event must get the same verdict on every peer
    const allowed = authority !== undefined && event.peerId === authority;
    return allowed
      ? Result.ok(undefined)
      : Result.err(
          new ReadOnlyPartition({ table, message: "global tables are written by the authority" }),
        );
  }
  const prefix = `${kind}:`;
  const actual = event.partition === undefined ? "" : String(event.partition);
  const matches =
    kind === "user" && author !== undefined
      ? actual === `user:${author.account}`
      : actual.startsWith(prefix) && actual.length > prefix.length;
  if (!matches) {
    return Result.err(
      new WrongPartition({ table, expected: kind, message: `expected a ${kind} partition` }),
    );
  }
  return checkConfined(table, kind, actual, author);
}

/**
 * Whether whatever vouched for the author confined it to instances, and named this one.
 *
 * `partitions === undefined` is "nothing here has anything to hold this to" and not "no
 * partitions": a link signs no partition list, so refusing on its absence would mean switching
 * accounts on in a device-key-only mesh refused every `org:` write.
 */
function checkConfined(
  table: string,
  kind: string,
  actual: string,
  author: Author | undefined,
): Result<void, ValidationError> {
  const partitions = author?.partitions;
  if (partitions === undefined || RESERVED.has(kind)) return Result.ok(undefined);
  if (partitions.some((p) => String(p) === actual)) return Result.ok(undefined);
  return Result.err(
    new PartitionNotGranted({
      table,
      partition: actual,
      message: "the author's grant does not list this partition",
    }),
  );
}

function checkColumns(table: Table, change: Change): Result<void, ValidationError> {
  if (change.kind === "delete") return Result.ok(undefined);
  const values = Object.fromEntries(change.kind === "insert" ? change.row : change.patch);
  const r = checkRow(table, values, change.kind);
  return r.isErr()
    ? Result.err(
        new SchemaViolation({
          table: String(table.name),
          key: String(change.key),
          cause: r.error,
          message: r.error.message,
        }),
      )
    : Result.ok(undefined);
}

/**
 * The manifest's own tables, held to whichever signature their **author class** names — a lookup
 * on the table, never a check of its name, so a new reserved table has to choose deliberately
 * rather than inherit whatever rule happened to be written here. Their columns are checked
 * either way; their partition is whatever instance they govern, which is the point of them.
 */
function checkReserved(
  table: string,
  change: Change,
  event: ProbeEvent,
  reserved: ReadonlyMap<string, Table>,
  authority: PeerId | undefined,
): Result<void, ValidationError> {
  const definition = reserved.get(table);
  if (definition === undefined)
    return Result.err(new UnknownTable({ table, message: "not in the schema" }));
  if (UNPINNED_RESERVED.has(table) && event.partition !== undefined) {
    return Result.err(
      new WrongPartition({ table, expected: "", message: `${table} is about no instance` }),
    );
  }
  const authored =
    RESERVED_AUTHOR_CLASS.get(table) === "subject"
      ? checkLink(change, event)
      : checkAuthored(table, event, authority);
  if (authored.isErr()) return authored;
  return checkColumns(definition, change);
}

/**
 * The authority's class: rules and corrections, which a device that could write them could use
 * to grant itself anything or to forge the authority's verdict. Checked by authorship, so a
 * forged row is refused at its own author and again at every peer that receives it.
 */
function checkAuthored(
  table: string,
  event: ProbeEvent,
  authority: PeerId | undefined,
): Result<void, ValidationError> {
  if (authority === undefined || event.peerId !== authority) {
    return Result.err(
      new ReadOnlyPartition({ table, message: `${table} is written by the authority` }),
    );
  }
  return Result.ok(undefined);
}

function checkPolicy(
  entry: Entry,
  rules: AllowBlock | undefined,
  change: Change,
  author: Author | undefined,
  before: RowLookup,
  isAuthority: boolean,
  schema: ValidatorSchema,
): Result<void, ValidationError> {
  if (author === undefined || rules === undefined) return Result.ok(undefined);
  if (entry.visibility === "authority" && !isAuthority) return Result.ok(undefined);
  const op: Operation = change.kind;
  const rule = resolveAllow(rules, op);
  const row = before(change.table, change.key);
  const patch =
    change.kind === "insert" ? change.row : change.kind === "update" ? change.patch : undefined;
  const allowed = evaluate(
    rule,
    policyContext(author, schema.rolesFor(entry.partition), row, patch),
  );
  return allowed
    ? Result.ok(undefined)
    : Result.err(
        new PolicyDenied({
          table: String(entry.table.name),
          key: String(change.key),
          op,
          message: `${op} on ${String(entry.table.name)} denied`,
        }),
      );
}

/** Builds the evaluator's context with absent (not undefined) optionals. */
/** Who a rule is evaluated for: what a grant says about its holder, or an actor a server vouches for. */
export type Principal = Pick<Grant, "account" | "role" | "claims">;

/**
 * A principal as `checkAuthor` resolved it, with the partitions it is confined to when whatever
 * vouched for it named any. A {@link Grant} already satisfies this; a link does not name
 * partitions, and `undefined` is "this rung has nothing to say" rather than "no partitions".
 */
export type Author = Principal & { readonly partitions?: readonly PartitionKey[] };

export function policyContext(
  principal: Principal,
  roles: readonly string[],
  row: Row | undefined,
  patch: Row | undefined,
): PolicyContext {
  const policyGrant: PolicyGrant =
    principal.role === undefined
      ? { account: principal.account, claims: principal.claims }
      : { account: principal.account, claims: principal.claims, role: principal.role };
  const base = { grant: policyGrant, roles };
  if (row !== undefined && patch !== undefined) return { ...base, row, patch };
  if (row !== undefined) return { ...base, row };
  if (patch !== undefined) return { ...base, patch };
  return base;
}
