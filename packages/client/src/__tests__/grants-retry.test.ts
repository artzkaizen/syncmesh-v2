import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, type PeerId } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { openGrants } from "../grants.js";

const ISSUER = createIdentity(seed(1)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const mint = (n: number) =>
  issueGrant(ISSUER, {
    account: `acct_${n}`,
    device: createIdentity(seed(n)).unwrap().peerId,
    role: "member",
    partitions: [ACME],
    validFor: Temporal.Duration.from({ hours: 1 }),
    now: T0,
  });

describe("a grant registering re-offers its device's parked events (gaps U42)", () => {
  test("a retry that panics is said, and the retries after it and close still run", async () => {
    const registry = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
    const asked: PeerId[] = [];
    const real = createEngine({
      peerId: createIdentity(seed(90)).unwrap().peerId,
      clock: createHlcClock({ now: () => T0 }),
      store: createMemoryEventStore(),
    });
    // the first retry panics, the second runs as the real one does
    const engine = {
      ...real,
      retryAuthor: (author: PeerId) => {
        asked.push(author);
        return asked.length === 1
          ? Promise.reject(new Error("the engine panicked"))
          : real.retryAuthor(author);
      },
    };
    const { bind } = openGrants(registry, { now: () => T0 });
    const retry = bind(engine);
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...said: unknown[]) => void warned.push(said);
    try {
      registry.register(mint(40)).unwrap();
      registry.register(mint(41)).unwrap();
      await retry.close();
    } finally {
      console.warn = warn;
    }
    expect(asked).toHaveLength(2);
    expect(warned).toHaveLength(1);
  });
});
