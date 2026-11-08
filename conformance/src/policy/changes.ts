/** The policy vectors' writes: rows, documents, links and grants, signed by the fixtures' authors. */
import type {
  CellValue,
  Change,
  DocChange,
  JsonValue,
  PartitionKey,
  PeerId,
  SyncEvent,
} from "@syncmesh/kernel";

import { linkKey } from "@syncmesh/engine";
import { eventId, hlcOf, parseAccountId, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import {
  bytesToHex,
  deriveLineage,
  issueGrant,
  signEvent,
  signLink,
  splitEnvelope,
  type Identity,
} from "@syncmesh/wire";

import {
  ACME,
  ADMIN,
  AUTHORITY,
  BETA,
  GAMMA,
  ISSUER,
  LEAD,
  LORO,
  MEMBER,
  MINUTE,
  NOW_MS,
  OUTSIDER,
  REVOKED,
  STRICT,
  TEAM,
  VIEWER,
  column,
  key,
  procedure,
  table,
} from "./schema.js";

export const cells = (values: Readonly<Record<string, CellValue>>) =>
  new Map(Object.entries(values).map(([k, v]) => [column(k), v]));
export const insert = (
  tbl: string,
  k: string,
  values: Readonly<Record<string, CellValue>>,
): Change => ({
  kind: "insert",
  table: table(tbl),
  key: key(k),
  row: cells({ id: k, ...values }),
});
export const update = (
  tbl: string,
  k: string,
  values: Readonly<Record<string, CellValue>>,
): Change => ({
  kind: "update",
  table: table(tbl),
  key: key(k),
  patch: cells(values),
});
export const remove = (tbl: string, k: string): Change => ({
  kind: "delete",
  table: table(tbl),
  key: key(k),
});
export const doc = (tbl: string, k: string, extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: table(tbl),
  key: key(k),
  column: column("content"),
  adapter: LORO,
  update: { bytes: Uint8Array.of(0x6c, 0x6f, 0x72, 0x6f) },
  ...extra,
});

/** Signs each author's events with its own run of sequence numbers, as wire hex. */
function createSigner() {
  const seqs = new Map<PeerId, number>();
  return (
    author: Identity,
    changes: readonly Change[],
    options: { partition?: PartitionKey; atMs?: number; seq?: number } = {},
  ) => {
    const n = options.seq ?? (seqs.get(author.peerId) ?? 0) + 1;
    seqs.set(author.peerId, Math.max(n, seqs.get(author.peerId) ?? 0));
    const seqNum = parseSeqNum(n).unwrap();
    const withLineage = changes.map((change, index) =>
      change.kind === "doc" && change.genesis === true && change.lineage === undefined
        ? { ...change, lineage: deriveLineage(author.peerId, seqNum, index) }
        : change,
    );
    const event: SyncEvent = {
      v: 1,
      id: eventId(author.peerId, seqNum),
      peerId: author.peerId,
      seqNum,
      hlc: hlcOf(options.atMs ?? NOW_MS - MINUTE, 0),
      procedure: procedure("policy.vector"),
      changes: withLineage,
      ...(options.partition !== undefined && { partition: options.partition }),
    };
    return bytesToHex(signEvent(event, author).wire);
  };
}

export interface GrantSpec {
  readonly who: Identity;
  readonly account: string;
  readonly role?: string;
  readonly partitions: readonly PartitionKey[];
  readonly claims?: Readonly<Record<string, JsonValue>>;
  readonly issuedMs?: number;
}

export const grantWire = ({ who, account, role, partitions, claims, issuedMs }: GrantSpec) =>
  bytesToHex(
    issueGrant(ISSUER, {
      account,
      device: who.peerId,
      partitions,
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: Temporal.Instant.fromEpochMilliseconds(issuedMs ?? NOW_MS - 10 * MINUTE),
      ...(role !== undefined && { role }),
      ...(claims !== undefined && { claims }),
    }),
  );

export const grants: readonly GrantSpec[] = [
  { who: AUTHORITY, account: "acct_authority", role: "admin", partitions: [ACME, BETA, STRICT] },
  { who: ADMIN, account: "acct_admin", role: "admin", partitions: [ACME, BETA, GAMMA] },
  { who: MEMBER, account: "acct_member", role: "member", partitions: [ACME, STRICT, TEAM] },
  {
    who: VIEWER,
    account: "acct_viewer",
    role: "viewer",
    partitions: [ACME, BETA, GAMMA],
    claims: { projects: ["p1", "p2"], permissions: { tasks: ["relabel"] }, team: "red" },
  },
  { who: OUTSIDER, account: "acct_outsider", role: "admin", partitions: [BETA] },
  { who: REVOKED, account: "acct_revoked", role: "member", partitions: [ACME] },
  { who: LEAD, account: "acct_lead", role: "lead", partitions: [TEAM] },
];

/** A signed `_links` row for `device` in `instance`, written by `author`. */
export function linkRow(
  account: Identity,
  device: Identity,
  instance: PartitionKey,
  op: "link" | "unlink",
  tamper: { readonly kind?: number; readonly sign?: Identity } = {},
): Change {
  const core = {
    v: 1,
    op,
    account: parseAccountId(String(account.peerId)).unwrap(),
    device: device.peerId,
    partition: instance,
    at: Temporal.Instant.fromEpochMilliseconds(NOW_MS - 20 * MINUTE),
  } as const;
  const wire = signLink(tamper.sign ?? account, core);
  const filed = linkKey(instance, device.peerId, splitEnvelope(wire).unwrap().core);
  // the columns say what the core says, unless a case tampers with one
  return {
    kind: "insert",
    table: table("_links"),
    key: filed,
    row: cells({
      id: String(filed),
      account: String(core.account),
      kind: tamper.kind ?? (op === "link" ? 0 : 1),
      at: NOW_MS - 20 * MINUTE,
      wire,
    }),
  };
}

export interface Step {
  readonly description: string;
  readonly events: readonly string[];
}

export interface Probe {
  readonly description: string;
  readonly event: string;
  /** Judged as this device's own local-only write (`MutateOptions.local`). */
  readonly local?: true;
}

/** One `can` question, asked of the shared rules after the mesh's steps (`engine/src/can.ts`). */
export interface CanCase {
  readonly description: string;
  /** Whose question; `null` is no principal at all. */
  readonly principal: {
    readonly account: string;
    readonly role?: string;
    readonly claims?: Readonly<Record<string, JsonValue>>;
  } | null;
  readonly what: `${string}.${string}`;
  readonly row?: Readonly<Record<string, CellValue>>;
  readonly patch?: Readonly<Record<string, CellValue>>;
  /** The instance whose synced `_policy` row is read; absent, the manifest's rules alone. */
  readonly partition?: string;
}

export interface Mesh {
  readonly description: string;
  /** `false` is ungranted mode: no grant is asked for, and no policy without a link. */
  readonly granted: boolean;
  readonly accounts: boolean;
  readonly steps: readonly Step[];
  readonly probes: readonly Probe[];
  readonly can?: readonly CanCase[];
}

/** Every author's signer, and `by`: the same, in `org:acme` unless told otherwise (`null`: none). */
export function createAuthors() {
  const sign = createSigner();
  const by = (who: Identity, changes: readonly Change[], at: PartitionKey | null = ACME) =>
    sign(who, changes, at === null ? {} : { partition: at });
  return { sign, by };
}

export type Authors = ReturnType<typeof createAuthors>;
