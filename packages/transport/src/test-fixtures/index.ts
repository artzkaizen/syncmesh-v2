/**
 * A granted peer with a real engine, and the context a mesh would hand a transport.
 *
 * Shared through a subpath because every transport's tests need the same one: the relay had a
 * copy differing only in that it also built the context, and the BLE tests were about to make a
 * third. What a peer *is* has to be one answer, or two suites can disagree about it.
 */

import type { EngineOptions } from "@syncmesh/engine";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant, type Identity } from "@syncmesh/wire";

import type { TransportContext } from "../transport.js";

export const schema = syncSchema({
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
  const engine = createEngine(options);
  // the context a mesh hands a transport; every transport's tests need one and none of them
  // should build their own, or two suites drift on what a peer even is
  const context: TransportContext = { engine, identity, grants, now: () => T0 };
  return { identity, grants, engine, context };
};

export type Peer = ReturnType<typeof peer>;
