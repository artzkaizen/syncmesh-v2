import type { EngineOptions } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import {
  createHlcClock,
  parsePartitionKey,
  readRow,
  type CellValue,
  type ColumnName,
  type Procedure,
  type RowKey,
  type TableName,
} from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  createGrantRegistry,
  createIdentity,
  decodeAndVerify,
  issueGrant,
  signEvent,
  type Identity,
} from "@syncmesh/wire";

export const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

export const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
export const ACME = parsePartitionKey("org:acme").unwrap();
export const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
export const ISSUER = createIdentity(seed(1)).unwrap();

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const mintFor = (device: Identity, account: string) =>
  issueGrant(ISSUER, {
    account,
    device: device.peerId,
    role: "member",
    partitions: [ACME],
    validFor: Temporal.Duration.from({ days: 1 }),
    now: T0,
  });

/** One granted peer: engine with a real validator, registry seeded with its own grant. */
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
  const context: TransportContext = { engine, identity, grants, now: () => T0 };
  return { identity, grants, engine, context };
};

export type Peer = ReturnType<typeof peer>;

/** One write on a peer, and the signed wire a relay would carry for it. */
export const write = async (p: Peer, id: string, body: string): Promise<Uint8Array> => {
  const event = (
    await p.engine.mutate(
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
      { partition: ACME },
    )
  ).unwrap();
  return signEvent(event, p.identity).wire;
};

export const bodyOf = (p: Peer, id: string): CellValue | undefined =>
  readRow(p.engine.state(), NOTES, key(id))?.get(BODY);

/** The relay-side stored entry for a signed wire. */
export const entryOf = (wire: Uint8Array) => decodeAndVerify(wire).unwrap();

export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
