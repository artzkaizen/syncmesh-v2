import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type {
  DevtoolsGrants,
  DevtoolsIdentity,
  DevtoolsLinks,
  DevtoolsOverview,
  DevtoolsSchema,
  DevtoolsSource,
  DevtoolsStore,
  DevtoolsSync,
  DevtoolsWrites,
} from "../contract.js";

/**
 * A {@link DevtoolsSource} with no mesh under it, for tests and for screenshots.
 *
 * This used to be the devtool's data, and that was the wrong thing for it to be: a panel built
 * against invented numbers is a panel whose author never found out which of the facts they wanted
 * a running client can actually answer. It is kept because the inverse is still true — a panel
 * test that had to boot an engine, open a store and wait for a fold would be a test nobody runs —
 * and because a fixture pinned to the real interface stops compiling the day the interface moves,
 * which is exactly when a panel needs telling.
 *
 * Everything is a constant and nothing ticks. `onChange` never fires unless a test makes it, so a
 * panel rendered over this is as quiet as a panel over an idle mesh, and a test that sees a second
 * render knows the panel caused it. Each reader builds a fresh object, so a panel that mutates
 * what it was handed cannot poison the next assertion.
 */

/** SAFETY: padded to 64 lowercase hex characters, which is the whole of the `PeerId` invariant. */
const peer = (hex: string): PeerId => hex.padEnd(64, "0") as PeerId;

/** SAFETY: `${peerId}-${seqNum}`, the shape `eventId` builds and `parseEventId` accepts. */
const event = (id: string): EventId => id as EventId;

/** SAFETY: a positive safe integer, which is the whole of the `SeqNum` invariant. */
const seq = (n: number): SeqNum => n as SeqNum;

const ALICE = peer("9da8");
const BOB = peer("3f10");
const CAROL = peer("c0de");

/**
 * Where the fixture's clock comes from. Every instant below is an offset from it — nine seconds
 * ago, two hours ago, expiring in four minutes — because an age against the wall clock, not a
 * date, is what the panels render.
 *
 * So it defaults to the wall clock instead of to a literal. A pinned epoch reads correctly on the
 * day it is written and then rots by a day a day: the link that closed "9s ago" becomes 732d ago,
 * the grant with "4h left" becomes two years expired, and every age column in every panel fills
 * with numbers that look like a bug in the panel. It stays injectable so a test can pin it.
 */
type Now = () => Temporal.Instant;

const identity = (at: Temporal.Instant): DevtoolsIdentity => ({
  peer: ALICE,
  account: "acct_42",
  role: "member",
  partitions: ["org:acme", "board:b1"],
  session: { account: "acct_42", role: "member" },
  sessionExpiresAt: at.add({ minutes: 4 }),
});

const overview = (): DevtoolsOverview => ({
  health: "catching-up",
  mediums: [
    { name: "lan", kind: "lan", condition: "ok", online: true, maxLinks: 8, priority: 2 },
    { name: "ble", kind: "ble", condition: "radio-off", online: false, maxLinks: 4, priority: 2 },
    // the case `$status` alone cannot show: the socket says it is fine, its own hub says it is down
    {
      name: "relay",
      kind: "websocket",
      condition: "ok",
      online: false,
      maxLinks: undefined,
      priority: 1,
    },
  ],
  handles: { observers: 6, subscriptions: 3, operations: 0, fetches: 0, links: 2 },
  running: true,
  settled: false,
  peers: 2,
  grants: 3,
  parked: 1,
});

const sync = (at: Temporal.Instant): DevtoolsSync => ({
  authors: [
    { peer: ALICE, cursor: seq(412), ahead: 0, holding: 0 },
    { peer: BOB, cursor: seq(96), ahead: 2, holding: 3 },
    // an author this device holds something of and has no contiguous run for: a gap, not a zero
    { peer: CAROL, cursor: undefined, ahead: 0, holding: 1 },
  ],
  scope: undefined,
  acks: [
    { peer: BOB, at: at, ours: seq(412), authors: 3 },
    { peer: CAROL, at: at.subtract({ hours: 2 }), ours: seq(88), authors: 1 },
  ],
  parked: [
    {
      event: event(`${CAROL}-9`),
      author: CAROL,
      kind: "missing-capability",
      verdict: "NoGrant",
      message: "the author holds no grant here",
      next: "c0de0000 holds no grant here: issue one, or relay the one it has.",
      retryWorthwhile: true,
    },
  ],
});

const links = (at: Temporal.Instant): DevtoolsLinks => ({
  self: ALICE,
  peers: [
    { peer: BOB, over: ["lan"], ackedAt: at },
    { peer: CAROL, over: ["lan", "ble"], ackedAt: at.subtract({ hours: 2 }) },
  ],
  // a relay socket reaches whoever is in the room and can name none of them
  silent: ["relay"],
  routes: [{ to: "authority", via: BOB, hops: 2, expiresAt: at.add({ minutes: 1 }) }],
  tally: [
    { transport: "lan", kind: "proven", count: 1 },
    { transport: "lan", kind: "refused", count: 1 },
    { transport: "ble", kind: "closed", count: 1 },
  ],
  recent: [
    { id: 2, kind: "closed", transport: "ble", peer: CAROL, why: "out of range", at: at },
    {
      id: 1,
      kind: "refused",
      transport: "lan",
      peer: undefined,
      why: "the door did not admit this peer",
      at: at.subtract({ seconds: 9 }),
    },
    {
      id: 0,
      kind: "proven",
      transport: "lan",
      peer: BOB,
      why: undefined,
      at: at.subtract({ seconds: 30 }),
    },
  ],
});

const schema = (): DevtoolsSchema => ({
  tables: [
    { table: "issue", partition: "org", visibility: "partition", sealed: false },
    { table: "comment", partition: "org", visibility: "partition", sealed: false },
    // sealed: a panel showing this table empty must say sealed, not empty and not broken
    { table: "note", partition: "board", visibility: "partition", sealed: true },
  ],
  sealedKinds: ["board"],
  presence: ["cursor"],
});

const store = (): DevtoolsStore => ({
  version: 4,
  log: [
    { peer: ALICE, local: false, events: 412, topSeq: 412, bytes: 184_320 },
    { peer: BOB, local: false, events: 96, topSeq: 98, bytes: 41_984 },
  ],
  tables: [
    { table: "issue", rows: 128 },
    { table: "comment", rows: 902 },
  ],
  floors: [{ peer: ALICE, local: false, seq: 100 }],
  writes: [{ status: "pending", count: 8 }],
});

const writes = (at: Temporal.Instant, limit: number): DevtoolsWrites => ({
  unsettled: [
    {
      id: "op_1",
      label: "issue.update",
      peer: ALICE,
      seq: seq(412),
      at: at,
      status: "pending",
      correctedBy: undefined,
      correctedReason: undefined,
    },
  ].slice(0, limit),
  truncated: false,
});

const grants = (at: Temporal.Instant): DevtoolsGrants => {
  const own = {
    device: ALICE,
    account: "acct_42",
    role: "member",
    partitions: ["org:acme", "board:b1"],
    sealed: ["board:b1"],
    // names, never values: a claim's value is where an email address ends up
    claims: ["seat", "email"],
    issuedAt: at.subtract({ hours: 20 }),
    expiresAt: at.add({ hours: 4 }),
    expired: false,
  };
  const lapsed = {
    ...own,
    device: CAROL,
    sealed: [],
    claims: [],
    expiresAt: at.subtract({ hours: 1 }),
    expired: true,
  };
  return { own, all: [own, lapsed], expiring: [lapsed, own], disputes: [] };
};

/**
 * Override any member to put one panel's subject under a microscope without building the rest.
 *
 * `now` is read once per reader call rather than once per source, so a panel left open over this
 * fixture watches its ages count up the way it would over a mesh — which is the only way to catch
 * an age column that renders once and then never moves.
 */
export function mockSource(
  overrides: Partial<DevtoolsSource> = {},
  now: Now = () => Temporal.Now.instant(),
): DevtoolsSource {
  return {
    identity: () => identity(now()),
    overview,
    sync: () => sync(now()),
    links: () => links(now()),
    schema,
    events: () => Promise.resolve(Result.ok([])),
    storage: () => Promise.resolve(Result.ok(store())),
    writes: (limit) => Promise.resolve(Result.ok(writes(now(), limit))),
    // empty is the healthy answer and the overwhelmingly common one: a fixture that shipped a
    // stranded run by default would teach every screenshot that a rotation is normal
    stranded: () => Promise.resolve(Result.ok([])),
    grants: () => grants(now()),
    timings: () => [],
    sql: undefined,
    onChange: () => () => undefined,
    close: () => undefined,
    ...overrides,
  };
}
