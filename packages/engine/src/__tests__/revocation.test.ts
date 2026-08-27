import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, parsePeerId, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { revocations, revokeDevice } from "../authority.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, fakeClock, key, row } from "./fixtures.js";

const PEER_C = parsePeerId("c".repeat(64)).unwrap();

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
/** When the authority withdraws the device's powers; every write is placed either side of it. */
const REVOKED_AT = NOW.add({ seconds: 2 });
const BEFORE = 1_000;
const AFTER = 5_000;

/** When each device's grant was issued; a test re-issues by moving this forward. */
const issued = new Map<PeerId, Temporal.Instant>();

const grantFor = (device: PeerId): Grant =>
  verifyGrant(
    issueGrant(ISSUER, {
      account: "acct_a",
      device,
      role: "member",
      partitions: [ACME, GLOBEX],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: issued.get(device) ?? NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();

/** A peer whose clock starts `offset` past `NOW`, and which can be moved across the revocation. */
const peerAt = (peerId: PeerId, offset: number) => {
  const clock = fakeClock(NOW.epochMilliseconds + offset);
  const engine = createEngine({
    peerId,
    clock,
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({
      schema,
      grantFor,
      authority: PEER_B, // B is the authority; A is an ordinary device
    }),
  });
  return { engine, at: (next: number) => clock.set(NOW.epochMilliseconds + next) };
};

type Side = ReturnType<typeof peerAt>;

const writeNote = (side: Side, id: string, partition = ACME) =>
  side.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ id, title: id })), {
    partition,
  });

const sync = async (from: Side, to: Side) =>
  (await to.engine.receiveBatch((await from.engine.eventsSince(new Map())).unwrap())).unwrap();

const tag = (r: { isErr: () => boolean; error?: { _tag: string } }) =>
  r.isErr() ? (r.error?._tag ?? "?") : "ok";

describe("revoking a device", () => {
  test("only the authority may write one, refused at the forger's own engine", async () => {
    const device = peerAt(PEER_A, BEFORE);
    issued.clear();
    const forged = await revokeDevice(device.engine, {
      device: PEER_A,
      partition: ACME,
      reason: "revoking myself is not a power I have",
    });
    expect(tag(forged)).toBe("ReadOnlyPartition");
  });

  test("a revoked device's writes quarantine at every peer that folded the revocation", async () => {
    issued.clear();
    const device = peerAt(PEER_A, BEFORE);
    const authority = peerAt(PEER_B, BEFORE);

    (await writeNote(device, "n1")).unwrap(); // written before, and it will stand
    expect((await sync(device, authority)).folded).toBe(1);

    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "reported stolen",
        at: REVOKED_AT,
      })
    ).unwrap();

    // the device is offline and never hears it: this is RFC-0016's honest window, and its own
    // engine still admits the write, because it is judging against the facts it holds
    device.at(AFTER);
    (await writeNote(device, "n2")).unwrap();

    // a third peer holds the revocation before it ever hears from the device
    const third = peerAt(PEER_C, AFTER);
    await sync(authority, third);
    const quarantined: string[] = [];
    third.engine.onQuarantine(({ reason }) => void quarantined.push(reason._tag));
    await third.engine.receiveBatch((await device.engine.eventsSince(new Map())).unwrap());

    // n1 stands and n2 does not: the verdict follows when each was written, not what this peer
    // happened to fold first — two peers holding both facts always reach the same answer
    expect(quarantined).toEqual(["GrantRevoked"]);
    expect(readRow(third.engine.state(), NOTES, N1)).toBeDefined();
    expect(readRow(third.engine.state(), NOTES, key("n2"))).toBeUndefined();
  });

  test("once it folds the revocation, the device refuses its own writes", async () => {
    issued.clear();
    const device = peerAt(PEER_A, BEFORE);
    const authority = peerAt(PEER_B, BEFORE);
    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "reported stolen",
        at: REVOKED_AT,
      })
    ).unwrap();
    await sync(authority, device);
    device.at(AFTER);
    expect(tag(await writeNote(device, "n2"))).toBe("GrantRevoked");
  });

  test("it withdraws one instance, not the device: elsewhere it still writes", async () => {
    issued.clear();
    const device = peerAt(PEER_A, BEFORE);
    const authority = peerAt(PEER_B, BEFORE);
    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "removed from this org",
        at: REVOKED_AT,
      })
    ).unwrap();
    await sync(authority, device);
    device.at(AFTER);

    expect(tag(await writeNote(device, "n1", ACME))).toBe("GrantRevoked");
    expect(tag(await writeNote(device, "g1", GLOBEX))).toBe("ok");
  });

  test("re-issuing readmits: a grant issued after the revocation is unaffected", async () => {
    issued.clear();
    const device = peerAt(PEER_A, BEFORE);
    const authority = peerAt(PEER_B, BEFORE);
    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "lost",
        at: REVOKED_AT,
      })
    ).unwrap();
    await sync(authority, device);
    device.at(AFTER);
    expect(tag(await writeNote(device, "n1"))).toBe("GrantRevoked");

    // the device is found; the issuer mints a fresh grant, and no second verb is needed
    issued.set(PEER_A, REVOKED_AT.add({ seconds: 1 }));
    expect(tag(await writeNote(device, "n2"))).toBe("ok");
    expect(readRow(device.engine.state(), NOTES, key("n2"))).toBeDefined();
  });

  test("a revocation reads back with who, where, when and why", async () => {
    issued.clear();
    const authority = peerAt(PEER_B, BEFORE);
    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "reported stolen",
        at: REVOKED_AT,
      })
    ).unwrap();
    expect(revocations(authority.engine)).toEqual([
      {
        device: String(PEER_A),
        partition: "org:acme",
        at: REVOKED_AT,
        reason: "reported stolen",
      },
    ]);
  });

  test("it travels as one ordinary signed event in the instance it concerns", async () => {
    issued.clear();
    const authority = peerAt(PEER_B, BEFORE);
    const event = (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "lost",
        at: REVOKED_AT,
      })
    ).unwrap();
    expect(String(event.partition)).toBe("org:acme"); // so it reaches exactly the devices it binds
    expect(event.changes).toHaveLength(1);
    expect(event.local).toBeUndefined();
  });

  test("the events it wrote before the instant still stand", async () => {
    issued.clear();
    const device = peerAt(PEER_A, BEFORE);
    const authority = peerAt(PEER_B, BEFORE);
    (await writeNote(device, "n1")).unwrap();
    await sync(device, authority);
    (
      await revokeDevice(authority.engine, {
        device: PEER_A,
        partition: ACME,
        reason: "left the org",
        at: REVOKED_AT,
      })
    ).unwrap();

    // revocation withdraws the power to write, and rewrites no history: N1 is still there
    expect(readRow(authority.engine.state(), NOTES, N1)).toBeDefined();
  });
});
