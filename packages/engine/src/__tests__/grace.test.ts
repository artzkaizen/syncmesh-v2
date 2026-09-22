import type { PeerId } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";

import { parsePartitionKey, parsePeerId, readRow } from "@syncmesh/kernel";
import { role } from "@syncmesh/policy";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { ValidatorOptions } from "../validate.js";

import { revokeDevice, setPolicy } from "../authority.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, NOTES, PEER_A, PEER_B, fakeClock, key, row } from "./fixtures.js";

const PEER_C = parsePeerId("c".repeat(64)).unwrap();

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      allow: ({ role: r }) => ({ $default: r("member") }),
    },
  },
});

const DOC = { notes: { $default: role("member") } };

const ISSUER = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const MINUTE = 60_000;
/** Every grant runs out five minutes after it is issued; the tests move the clock inside that. */
const VALID_FOR = Temporal.Duration.from({ minutes: 5 });
/** Wide enough to swallow the last minute of a grant issued at `NOW`, and no wider. */
const GRACE = Temporal.Duration.from({ minutes: 2 });
/** Four minutes in: one minute of validity left, which is inside a two-minute grace window. */
const LATE = 4 * MINUTE;

/** When each device's grant was issued; a test renews by moving this forward. */
const issued = new Map<PeerId, Temporal.Instant>();

const grantFor = (device: PeerId): Grant =>
  verifyGrant(
    issueGrant(ISSUER, {
      account: "acct_a",
      device,
      role: "member",
      partitions: [ACME, GLOBEX],
      validFor: VALID_FOR,
      now: issued.get(device) ?? NOW,
    }),
    ISSUER.peerId,
    NOW,
  ).unwrap();

/**
 * A peer whose clock starts at `NOW` and can be moved towards its grant's expiry. `clocked: false`
 * is the validator that was never given a `now` — the shape every caller had before this rung.
 */
const peerAt = (peerId: PeerId, clocked = true) => {
  let ms = NOW.epochMilliseconds;
  const clock = fakeClock(ms);
  const options = { schema, grantFor, authority: PEER_B } satisfies ValidatorOptions;
  if (clocked) Object.assign(options, { now: () => Temporal.Instant.fromEpochMilliseconds(ms) });
  const engine = createEngine({
    peerId,
    clock,
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator(options),
  });
  return {
    engine,
    at: (offset: number) => {
      ms = NOW.epochMilliseconds + offset;
      clock.set(ms);
    },
  };
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

/** An instance that has published `grace`, and the peers that hold that row. */
const strictMesh = async (clocked = true) => {
  issued.clear();
  const device = peerAt(PEER_A, clocked);
  const authority = peerAt(PEER_B, clocked);
  const third = peerAt(PEER_C, clocked);
  (await setPolicy(authority.engine, ACME, DOC, { grace: GRACE })).unwrap();
  await sync(authority, device);
  await sync(authority, third);
  return { device, authority, third };
};

const strict = async (clocked = true) => (await strictMesh(clocked)).device;

describe("a partition's grace window", () => {
  test("with none set, a grant good for another minute writes", async () => {
    issued.clear();
    const device = peerAt(PEER_A);
    device.at(LATE);
    expect(tag(await writeNote(device, "n1"))).toBe("ok");
  });

  test("wider than what is left of the grant, the write is refused as stale", async () => {
    const device = await strict();
    device.at(LATE);

    const refused = await writeNote(device, "n1");
    expect(tag(refused)).toBe("GrantStale");
    expect(readRow(device.engine.state(), NOTES, key("n1"))).toBeUndefined();
  });

  test("it binds one instance and not the device: elsewhere the same grant still writes", async () => {
    const device = await strict();
    device.at(LATE);

    // one grant, one clock, two verdicts — which is the whole of what per-partition means
    expect(tag(await writeNote(device, "n1", ACME))).toBe("GrantStale");
    expect(tag(await writeNote(device, "g1", GLOBEX))).toBe("ok");
  });

  test("renewing clears it: a freshly issued grant passes the same window", async () => {
    const device = await strict();
    device.at(LATE);
    expect(tag(await writeNote(device, "n1"))).toBe("GrantStale");

    // the device reaches the authority and is re-issued; nothing else about it changed
    issued.set(PEER_A, NOW.add({ minutes: 4 }));
    expect(tag(await writeNote(device, "n2"))).toBe("ok");
    expect(readRow(device.engine.state(), NOTES, key("n2"))).toBeDefined();
  });

  test("a validator with no clock skips it, so nothing that worked before starts failing", async () => {
    const device = await strict(false);
    device.at(LATE);
    expect(tag(await writeNote(device, "n1"))).toBe("ok");
  });

  test("a peer that receives the write late still folds it: the stamp decides, not arrival", async () => {
    const { device, third } = await strictMesh();
    expect(tag(await writeNote(device, "n1"))).toBe("ok");

    // the device went dark and syncs its backlog after the window closed — the case the rung
    // exists for, and the one where judging by arrival would quarantine it at every peer but one
    third.at(LATE);
    const report = await sync(device, third);
    expect(report.quarantined).toBe(0);
    expect(readRow(third.engine.state(), NOTES, key("n1"))).toBeDefined();
  });

  test("the authority is not locked out by the window it published", async () => {
    const { device, authority } = await strictMesh();

    // its own grant is now inside the grace it declared, and it must still be able to govern:
    // an authority that cannot revoke a stolen device because of its own window is worse than
    // no window at all
    authority.at(LATE);
    expect(
      tag(
        await revokeDevice(authority.engine, {
          device: PEER_A,
          partition: ACME,
          reason: "reported stolen",
        }),
      ),
    ).toBe("ok");
    device.at(LATE);
    expect(tag(await writeNote(device, "n9"))).toBe("GrantStale");
  });
});
