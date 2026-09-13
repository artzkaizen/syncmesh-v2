export type { OpenChannel } from "./channel.js";
export { channelTests } from "./channel.js";

import type { Engine, Quarantined, SuiteCase } from "@syncmesh/engine";
import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import {
  check,
  createEngine,
  createMemoryEventStore,
  createValidator,
  equal,
} from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";

import type { TransportContext } from "../transport.js";

/** One peer the suite built; wire its transport to the others however the medium connects. */
export interface SuitePeer extends TransportContext {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly grants: GrantRegistry;
}

/** What `connect` hands back: the running network and, where the medium can, its failure knobs. */
export interface SuiteNetwork {
  /** Frames in flight and folds settled. */
  readonly settle: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /** Absent capabilities skip their cases — a fact about the medium, not a failure. */
  readonly chaos?: {
    /** The next `count` frames vanish after a successful send. */
    readonly drop: (count: number) => void;
    /** Ask every peer to re-request from its last contiguous position. */
    readonly resyncAll: () => void;
  };
}

/** Connects the peers in a chain — peer i talks only to i−1 and i+1; ends never meet directly. */
export type Connect = (peers: readonly SuitePeer[]) => Promise<SuiteNetwork>;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const rowKey = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const schema = defineSchema({
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

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 1 + i)).unwrap();

/**
 * Three peers of the suite's own fixture — an engine, an identity and a grant each, over the
 * suite's schema.
 *
 * Exported so a transport package can test its own bookkeeping (which peers a radio reaches,
 * what a link does on close) against the same peers the contract runs on, instead of standing up
 * a second engine fixture that drifts from this one.
 */
export const suitePeers = (): readonly [SuitePeer, SuitePeer, SuitePeer] => [
  buildPeer(40, 100),
  buildPeer(80, 500),
  buildPeer(120, 900),
];

const buildPeer = (n: number, startMs: number): SuitePeer => {
  const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => n + i)).unwrap();
  const grants = createGrantRegistry({ issuer: issuer.peerId, now: () => T0 });
  grants
    .register(
      issueGrant(issuer, {
        account: `acct_${n}`,
        device: identity.peerId,
        role: "member",
        partitions: [ACME],
        validFor: Temporal.Duration.from({ days: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  let ms = startMs;
  const engine = createEngine({
    peerId: identity.peerId,
    clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) }),
    store: createMemoryEventStore(),
    validate: createValidator({ schema, grantFor: (p) => grants.grantFor(p) }),
  });
  return { engine, identity, grants, now: () => T0 };
};

const write = (peer: SuitePeer, id: string, body: string) =>
  peer.engine.mutate(
    CREATE,
    (tx) =>
      tx.insert(
        NOTES,
        rowKey(id),
        new Map([
          [ID, id],
          [BODY, body],
        ]),
      ),
    { partition: ACME },
  );
const bodyOf = (peer: SuitePeer, id: string): string | undefined => {
  const value = readRow(peer.engine.state(), NOTES, rowKey(id))?.get(BODY);
  // SAFETY: the suite is the only writer of this table, and it writes body as text
  return value as string | undefined;
};

/**
 * The contract every transport must satisfy, over a three-peer chain, for any test runner.
 *
 * @example
 * for (const c of transportTests(connectOverLoopback)) test(c.name, c.run);
 */
export function transportTests(connect: Connect): readonly SuiteCase[] {
  const openNetwork = async () => {
    const peers = suitePeers();
    const network = await connect(peers);
    return { peers, network };
  };

  return [
    {
      name: "transport: three peers in a chain converge, grants first, zero quarantines",
      run: async () => {
        const { peers, network } = await openNetwork();
        const [a, b, c] = peers;
        const quarantined: Quarantined[] = [];
        for (const p of peers) p.engine.onQuarantine((q) => void quarantined.push(q));
        (await write(a, "n1", "from-a")).unwrap();
        (await write(c, "n2", "from-c")).unwrap();
        await network.settle();
        equal(quarantined.length, 0, "quarantines");
        for (const [peer, label] of [
          [a, "a"],
          [b, "b"],
          [c, "c"],
        ] as const) {
          equal(bodyOf(peer, "n1"), "from-a", `n1 at ${label}`);
          equal(bodyOf(peer, "n2"), "from-c", `n2 at ${label}`);
        }
        await network.stop();
      },
    },
    {
      name: "transport: concurrent writes from every peer while apart, none of them lost",
      run: async () => {
        // three peers, each writing a row only it knows about, none able to see the others. The
        // keys differ, so nothing competes and the correct answer is that all three survive —
        // which is only interesting because the middle peer must carry the outer two to each
        // other, and a chain is where a hop that quietly stops forwarding hides
        const { peers, network } = await openNetwork();
        const [a, b, c] = peers;
        (await write(a, "from-a", "a")).unwrap();
        (await write(b, "from-b", "b")).unwrap();
        (await write(c, "from-c", "c")).unwrap();
        await network.settle();
        for (const [peer, label] of [
          [a, "a"],
          [b, "b"],
          [c, "c"],
        ] as const)
          for (const id of ["from-a", "from-b", "from-c"])
            equal(bodyOf(peer, id), id.slice(-1), `${id} at ${label}`);
        await network.stop();
      },
    },
    {
      name: "transport: a peer with nothing of its own to say keeps receiving, round after round",
      run: async () => {
        // the shape that hid a wedged link: `b` writes nothing at all, and must still be carrying
        // `a`'s writes to `c` on the fourth round as faithfully as on the first
        const { peers, network } = await openNetwork();
        const [a, , c] = peers;
        for (const round of [1, 2, 3, 4]) {
          (await write(a, `r${round}`, `round-${round}`)).unwrap();
          await network.settle();
          for (const [peer, label] of [
            [a, "a"],
            [c, "c"],
          ] as const)
            equal(bodyOf(peer, `r${round}`), `round-${round}`, `r${round} at ${label}`);
        }
        await network.stop();
      },
    },
    {
      name: "transport: a write after the sessions are up reaches the far end live",
      run: async () => {
        const { peers, network } = await openNetwork();
        const [a, , c] = peers;
        await network.settle();
        (await write(a, "n3", "late")).unwrap();
        await network.settle();
        equal(bodyOf(c, "n3"), "late", "late write at c");
        await network.stop();
      },
    },
    {
      name: "transport: relayed events carry the author's signature end to end",
      run: async () => {
        const { peers, network } = await openNetwork();
        const [a, b, c] = peers;
        (await write(a, "n1", "signed")).unwrap();
        await network.settle();
        const held = (await c.engine.eventsSince(new Map())).unwrap();
        const fromA = held.find((e) => e.event.peerId === a.identity.peerId);
        check(fromA !== undefined, "c holds a's event");
        check(fromA.sig !== undefined, "with a's original signature, relayed by b");
        check(c.grants.grantFor(a.identity.peerId) !== undefined, "and a's grant");
        equal(bodyOf(b, "n1"), "signed", "b folded it too");
        await network.stop();
      },
    },
    {
      name: "transport: a lost frame is never jumped; resync converges (needs chaos)",
      run: async () => {
        const { peers, network } = await openNetwork();
        if (network.chaos === undefined) {
          await network.stop();
          return;
        }
        const [a, b] = peers;
        await network.settle();
        (await write(a, "n1", "one")).unwrap();
        await network.settle();
        network.chaos.drop(1);
        (await write(a, "n2", "two")).unwrap();
        (await write(a, "n3", "three")).unwrap();
        await network.settle();
        check(bodyOf(b, "n3") === undefined, "n3 held out behind the lost n2");
        network.chaos.resyncAll();
        await network.settle();
        equal(bodyOf(b, "n2"), "two", "n2 after resync");
        equal(bodyOf(b, "n3"), "three", "n3 after resync");
        await network.stop();
      },
    },
  ];
}
