/**
 * A granted peer with a real engine, and the context a mesh would hand a transport.
 *
 * Shared through a subpath because every transport's tests need the same one: the relay had a
 * copy differing only in that it also built the context, and the BLE tests were about to make a
 * third. What a peer *is* has to be one answer, or two suites can disagree about it.
 */

import type { EngineOptions } from "@syncmesh/engine";
import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow, type PartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant, type Identity } from "@syncmesh/wire";

import type { TransportContext } from "../transport.js";

const org = partition("org", { roles: ladder("member") });
export const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

export const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
export const ACME = parsePartitionKey("org:acme").unwrap();
export const GLOBEX = parsePartitionKey("org:globex").unwrap();
export const ISSUER = createIdentity(seed(1)).unwrap();

/** Overrides for a re-mint: a later `now` is what makes one grant supersede another. */
interface MintOptions {
  readonly now?: Temporal.Instant;
  readonly partitions?: readonly PartitionKey[];
}

export const mintFor = (
  device: Identity,
  account: string,
  { now = T0, partitions = [ACME, GLOBEX] }: MintOptions = {},
) =>
  issueGrant(ISSUER, {
    account,
    device: device.peerId,
    role: "member",
    partitions,
    validFor: Temporal.Duration.from({ days: 1 }),
    now,
  });

export const peer = (n: number, account: string, startMs = 100) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  grants.register(mintFor(identity, account)).unwrap();
  let ms = startMs;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) });
  const options: EngineOptions = {
    peerId: identity.peerId,
    clock,
    store: createMemoryEventStore(),
    validate: createValidator({ schema, grantFor: (p) => grants.grantFor(p) }),
  };
  const engine = createEngine(options);
  // the context a mesh hands a transport; every transport's tests need one and none of them
  // should build their own, or two suites drift on what a peer even is
  const context: TransportContext = { engine, identity, grants, now: () => T0 };
  return { identity, grants, engine, context };
};

export type Peer = ReturnType<typeof peer>;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; the naming rules are not what these tests are about */
export const NOTES = "notes" as TableName;
export const ID = "id" as ColumnName;
export const BODY = "body" as ColumnName;
export const CREATE = "notes.create" as Procedure;
export const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** One row into one peer's log — the write every bridge test syncs. */
export const write = (p: Pick<Peer, "engine">, id: string, body: string, partition = ACME) =>
  p.engine.mutate(
    CREATE,
    (tx) =>
      tx.insert(
        NOTES,
        key(id),
        new Map([
          [ID, id],
          [BODY, body],
        ]),
      ),
    { partition },
  );

/** What a peer's state says that row's body is, or `undefined` where the row never arrived. */
export const bodyOf = (p: Peer, id: string) => readRow(p.engine.state(), NOTES, key(id))?.get(BODY);

export * from "./gated.js";
