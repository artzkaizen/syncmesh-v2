import type { EngineOptions } from "@syncmesh/engine";
import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant, type Identity } from "@syncmesh/wire";

import { bridgeFramedLink } from "../bridge.js";
import { loopbackPair } from "../link.js";

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
export const GLOBEX = parsePartitionKey("org:globex").unwrap();
export const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => n + i);
export const ISSUER = createIdentity(seed(1)).unwrap();

export const mintFor = (device: Identity, account: string) =>
  issueGrant(ISSUER, {
    account,
    device: device.peerId,
    role: "member",
    partitions: [ACME, GLOBEX],
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
  return { identity, grants, engine: createEngine(options) };
};

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; the naming rules are not what these tests are about */
export const NOTES = "notes" as TableName;
export const ID = "id" as ColumnName;
export const BODY = "body" as ColumnName;
export const CREATE = "notes.create" as Procedure;
export const key = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export type Peer = ReturnType<typeof peer>;

/** One row into one peer's log — the write every bridge test syncs. */
export const write = (p: Peer, id: string, body: string, partition = ACME) =>
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

/** Two peers bridged over one loopback, and the rounds that settle whatever they owe each other. */
export const connect = (x: Peer, y: Peer) => {
  const { a, b, control } = loopbackPair();
  const bridgeFor = (p: Peer, link: Parameters<typeof bridgeFramedLink>[0]) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
    });
  const bx = bridgeFor(x, a);
  const by = bridgeFor(y, b);
  // one round per hop a frame can cause: cursors → events → cursors-back → events. Anything
  // needing more rounds than that is a bridge bug, not a test-timing problem.
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, control, settle };
};
