import type { Engine, EngineOptions } from "@syncmesh/engine";
import type { PartitionKey, PeerId, Procedure, TableName } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Grant, Identity } from "@syncmesh/wire";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { syncSchema, scalarText, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";

import type { ChangeMappings } from "../mapping.js";
import type { SourceRow } from "../source.js";

import { cdcAllow } from "../rules.js";

export const ACME = parsePartitionKey("org:acme").unwrap();
export const GLOBEX = parsePartitionKey("org:globex").unwrap();

/**
 * One CDC-backed collection and one rule shape per failure worth pinning: `tasks` is written
 * the way a projection should be, `owned` reads the author through `owner()` and `flagged`
 * reads the column through `rowIs`.
 */
export const schema = syncSchema({
  partitions: { org: {} },
  roles: { org: ["system", "admin", "viewer"] },
  tables: {
    tasks: {
      columns: {
        id: t.text().primaryKey(),
        orgId: t.text(),
        title: t.text(),
        ownerId: t.text(),
      },
      partition: "org",
      allow: ({ role }) => cdcAllow({ read: role("viewer"), writer: "system" }),
    },
    owned: {
      columns: { id: t.text().primaryKey(), orgId: t.text(), ownerId: t.text() },
      partition: "org",
      allow: ({ owner }) => ({ $default: owner("ownerId") }),
    },
    flagged: {
      columns: { id: t.text().primaryKey(), orgId: t.text(), ownerId: t.text() },
      partition: "org",
      allow: ({ rowIs }) => ({ $default: rowIs({ orgId: "acme" }) }),
    },
  },
});

export const TASKS = schema.tables.tasks.name;
export const OWNED = schema.tables.owned.name;
export const FLAGGED = schema.tables.flagged.name;

const identityFrom = (byte: number) =>
  createIdentity(Uint8Array.from({ length: 32 }, (_, i) => byte + i)).unwrap();

const issuer = identityFrom(50);
export const authority = identityFrom(70);
export const phone = identityFrom(110);

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const grantFor = (device: PeerId, account: string, role: string): Grant =>
  verifyGrant(
    issueGrant(issuer, {
      account,
      device,
      role,
      partitions: [ACME, GLOBEX],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    issuer.peerId,
    NOW,
  ).unwrap();

/** The authority writes as `system`; the phone is an ordinary reader, which is the whole point. */
export const grants = new Map<PeerId, Grant>([
  [authority.peerId, grantFor(authority.peerId, "acct_system", "system")],
  [phone.peerId, grantFor(phone.peerId, "acct_alice", "viewer")],
]);

export const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });

/** An engine whose validator knows the manifest, its reserved tables, and who the authority is. */
export const peerAt = (identity: Identity, extra: Partial<EngineOptions> = {}): Engine =>
  createEngine({
    peerId: identity.peerId,
    clock: clock(),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({
      schema,
      grantFor: (peer) => grants.get(peer),
      authority: authority.peerId,
    }),
    ...extra,
  });

/** An engine with no validator at all: the only way to author an event the rules would refuse. */
export const forgerAt = (identity: Identity): Engine =>
  createEngine({
    peerId: identity.peerId,
    clock: clock(),
    store: createMemoryEventStore(),
    merge: schema.merge,
  });

/** Every row of these tables carries its instance in `orgId`, which is where the mapping reads it. */
const orgOf = (row: SourceRow) => `org:${scalarText(row.orgId) ?? ""}`;

export const mappings = {
  tasks: { collection: schema.tables.tasks, partition: orgOf },
  owned: { collection: schema.tables.owned, partition: orgOf },
  flagged: { collection: schema.tables.flagged, partition: orgOf },
} satisfies ChangeMappings;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixture; a procedure is an opaque label on the event */
export const WRITE = "tasks.write" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** Waits for the capture loop, which runs on its own. Fails loudly rather than hanging a suite. */
export async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The failure a Result carries; fails the test rather than narrowing at every call site. */
export const failure = <T, E>(result: Result<T, E>): E => {
  if (!result.isErr()) throw new Error("expected a failure, got a value");
  return result.error;
};

/** Every row of a collection as this engine holds it, keyed and plain, for comparing two peers. */
export const rowsOf = (engine: Engine, partition: PartitionKey, table: TableName) =>
  [...engine.rowsIn(table, partition)]
    .map(
      ([key, row]) =>
        [String(key), Object.fromEntries([...row].map(([c, v]) => [String(c), v]))] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
