import type { PartitionKey } from "@syncmesh/kernel";
import type { Change, PeerId, Row, RowKey, SyncEvent, TableName } from "@syncmesh/kernel";
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

import {
  GrantDeviceMismatch,
  LocalOnly,
  NoGrant,
  PartitionNotGranted,
  PolicyDenied,
  ReadOnlyPartition,
  SchemaViolation,
  UnknownTable,
  WrongPartition,
  type ValidationError,
} from "./errors.js";

/** What validation needs from a schema, structurally, so any concrete `Schema<P, R, C>` fits. */
export interface ValidatorSchema {
  readonly entries: readonly {
    readonly table: Table;
    readonly partition: string;
    readonly visibility: "partition" | "authority";
    readonly allow?: AllowBlock;
  }[];
  rolesFor(kind: string): readonly string[];
}

/** The event before it has a sequence number: everything validation reads. */
export type ProbeEvent = Pick<SyncEvent, "peerId" | "partition" | "changes" | "local">;

/** The row a change applies to, as the device holds it; `undefined` when absent. */
export type RowLookup = (table: TableName, key: RowKey) => Row | undefined;

/** What the device holds about the rows an event touches. */
export interface StateLookup {
  readonly row: RowLookup;
  /** The partition the row was first written in; `undefined` when absent or unpartitioned. */
  readonly partition: (table: TableName, key: RowKey) => PartitionKey | undefined;
}

export interface ValidatorOptions {
  readonly schema: ValidatorSchema;
  /** `null` is ungranted mode: grant and policy steps are skipped; schema never is. */
  readonly grantFor: ((peer: PeerId) => Grant | undefined) | null;
  /** The relay: may write global tables, and is where authority-visibility rules run. */
  readonly isAuthority?: boolean;
  /** The one peer whose events may write `global` tables; named like the issuer is, checked against the event's author. Absent, only `isAuthority` may. */
  readonly authority?: PeerId;
}

export interface Validator {
  /** Ladder: grant → device → partition → schema → policy. The first failure is the verdict. */
  readonly validate: (event: ProbeEvent, before: StateLookup) => Result<void, ValidationError>;
}

const RESERVED = new Set(["global", "user", "local"]);

export function createValidator(options: ValidatorOptions): Validator {
  const { schema, grantFor, isAuthority = false, authority } = options;
  const entries = new Map(schema.entries.map((e) => [String(e.table.name), e]));

  const validate: Validator["validate"] = (event, before) => {
    const grant = grantFor === null ? undefined : grantFor(event.peerId);
    if (grantFor !== null) {
      if (grant === undefined)
        return Result.err(
          new NoGrant({ peer: event.peerId, message: "no grant held for this author" }),
        );
      if (grant.device !== event.peerId) {
        return Result.err(
          new GrantDeviceMismatch({
            peer: event.peerId,
            device: grant.device,
            message: "the grant names another device",
          }),
        );
      }
    }
    for (const change of event.changes) {
      const table = String(change.table);
      const entry = entries.get(table);
      if (entry === undefined)
        return Result.err(new UnknownTable({ table, message: "not in the schema" }));
      const partition = checkPartition(table, entry, event, grant, isAuthority, authority);
      if (partition.isErr()) return partition;
      const held = before.partition(change.table, change.key);
      if (held !== undefined && held !== event.partition) {
        return Result.err(
          new WrongPartition({ table, expected: held, message: `the row belongs to ${held}` }),
        );
      }
      const columns = checkColumns(entry.table, change);
      if (columns.isErr()) return columns;
      const policy = checkPolicy(entry, change, grant, before.row, isAuthority, schema);
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
  grant: Grant | undefined,
  isAuthority: boolean,
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
    const allowed = authority === undefined ? isAuthority : event.peerId === authority;
    return allowed
      ? Result.ok(undefined)
      : Result.err(
          new ReadOnlyPartition({ table, message: "global tables are written by the authority" }),
        );
  }
  const prefix = `${kind}:`;
  const actual = event.partition === undefined ? "" : String(event.partition);
  const matches =
    kind === "user" && grant !== undefined
      ? actual === `user:${grant.account}`
      : actual.startsWith(prefix) && actual.length > prefix.length;
  if (!matches) {
    return Result.err(
      new WrongPartition({ table, expected: kind, message: `expected a ${kind} partition` }),
    );
  }
  if (
    grant !== undefined &&
    !RESERVED.has(kind) &&
    !grant.partitions.some((p) => String(p) === actual)
  ) {
    return Result.err(
      new PartitionNotGranted({
        table,
        partition: actual,
        message: "the author's grant does not list this partition",
      }),
    );
  }
  return Result.ok(undefined);
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

function checkPolicy(
  entry: Entry,
  change: Change,
  grant: Grant | undefined,
  before: RowLookup,
  isAuthority: boolean,
  schema: ValidatorSchema,
): Result<void, ValidationError> {
  if (grant === undefined || entry.allow === undefined) return Result.ok(undefined);
  if (entry.visibility === "authority" && !isAuthority) return Result.ok(undefined);
  const op: Operation = change.kind;
  const rule = resolveAllow(entry.allow, op);
  const row = before(change.table, change.key);
  const patch =
    change.kind === "insert" ? change.row : change.kind === "update" ? change.patch : undefined;
  const allowed = evaluate(
    rule,
    policyContext(grant, schema.rolesFor(entry.partition), row, patch),
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
export function policyContext(
  grant: Grant,
  roles: readonly string[],
  row: Row | undefined,
  patch: Row | undefined,
): PolicyContext {
  const policyGrant: PolicyGrant =
    grant.role === undefined
      ? { account: grant.account, claims: grant.claims }
      : { account: grant.account, claims: grant.claims, role: grant.role };
  const base = { grant: policyGrant, roles };
  if (row !== undefined && patch !== undefined) return { ...base, row, patch };
  if (row !== undefined) return { ...base, row };
  if (patch !== undefined) return { ...base, patch };
  return base;
}
