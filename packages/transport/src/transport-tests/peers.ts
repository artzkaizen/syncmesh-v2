/**
 * What every transport case is built out of: three peers with real engines, the writes and
 * reads used to check convergence, and the severance knobs a medium may or may not offer.
 *
 * Split from `./index.ts` because the cases and the fixtures are read for different reasons —
 * somebody adding a medium reads the cases, somebody debugging one reads these.
 */

import type { Engine } from "@syncmesh/engine";
import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity, issueGrant } from "@syncmesh/wire";

import type { ByteStream } from "../framing.js";
import type { Transport, TransportContext } from "../transport.js";

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
  /** Every transport in this network, as the mesh would hold them; what the contract reads the shape of. */
  readonly transports: readonly Transport[];
  /**
   * `Transport.wake` on every transport in this network: something outside knows the link may
   * have changed, so look at it now rather than at the next deadline.
   *
   * Fanned out rather than aimed, for the same reason `chaos.resyncAll` is. An OS reachability
   * callback is not addressed to one source either — a mesh hands it to all of them, and a
   * transport for which the nudge is free is a transport it costs nothing to hand it to. Absent
   * where no transport of this medium implements the capability, and its case skips.
   */
  readonly wake?: () => void;
  /** Absent capabilities skip their cases — a fact about the medium, not a failure. */
  readonly chaos?: {
    /** The next `count` frames vanish after a successful send. */
    readonly drop: (count: number) => void;
    /** Ask every peer to re-request from its last contiguous position. */
    readonly resyncAll: () => void;
    /**
     * The medium goes away **without a clean close** — abandoned, not ended.
     *
     * Silence is the fault under test, and it is the whole of the capability. Switch a phone's
     * Wi-Fi off and the socket underneath is not closed so much as orphaned: no `close` event, no
     * write that throws, no status callback, nothing at all. The transport above it goes on
     * believing it holds a live link, so a write made in that state is folded locally, handed to
     * a link that carries nothing, and sits there. What eventually notices is a liveness
     * deadline — for the relay, 2.5× its 15s keepalive, so **up to ~37 seconds** in which a
     * device that is back on the network syncs nothing and a person reaches for the reload.
     * Bluetooth off → on is the same failure over another medium and worse: nothing tells the BLE
     * transport the adapter's state changed, so there is no deadline to wait out and it does not
     * recover at all.
     *
     * Both were found weeks apart, by a person rather than by a test, and the reason no test
     * caught either is this: **every fake in the tree ends a link by ending it.** A `sever` that
     * politely fires a close event, throws from `send`, or flips `onStatus` would pass every case
     * below while reproducing neither incident, because the transport would have been *told* —
     * and being told is precisely what does not happen. So while a medium is severed it must
     * accept writes and deliver none of them, and deliver nothing inbound.
     *
     * What it may report is only what the real medium reports **about itself**: a Bluetooth
     * adapter does say its own power state changed, because CoreBluetooth really does deliver
     * that, and a fixture that stayed silent there would be modelling a platform that does not
     * exist. What no medium may report is anything about a *link* — no close, no failed write,
     * no disconnect. That line is the whole difference between the two, and it is where both
     * incidents lived: the platform talks about the radio, and nothing at all talks about the
     * connections over it.
     *
     * Declared with `restore` or not at all: a medium that can be broken and not mended can only
     * show that it broke.
     */
    readonly sever?: () => void;
    /**
     * The medium works again, and says exactly as much about it as the severance did.
     *
     * Anything beyond what the real medium announces would be the nudge whose absence these
     * cases are about — and `wake` is where a nudge belongs, so that a case can tell the two
     * apart. What becomes of a link that was open when the medium went is the medium's own
     * truth: a socket orphaned by a Wi-Fi drop stays orphaned however healthy the network
     * becomes, and a fixture that quietly heals it is modelling a flicker rather than the
     * incident. {@link severable} keeps that half honest.
     */
    readonly restore?: () => void;
  };
}

/**
 * The bookkeeping a `chaos.sever` needs, in one place because every medium needs the same of it.
 *
 * A severance has two halves, and a fixture that implements only the first reproduces nothing.
 * While the medium is gone, nothing crosses it — {@link Severable.carrying}. And a link that was
 * open when it went stays dead *after* the medium is back — the handle {@link Severable.linked}
 * hands out, one per link, which answers `false` for ever once a severance has passed under it.
 *
 * That second half is what makes the cases a reproduction of the incident. An orphaned socket
 * does not heal when the Wi-Fi does; what recovers a mesh is a new link, opened either because
 * something noticed or because something said so.
 */
export interface Severable {
  /** Whether the medium is carrying anything at all right now. */
  readonly carrying: () => boolean;
  /** One link's own liveness: false while the medium is gone, and false for good once it has been. */
  readonly linked: () => () => boolean;
  readonly sever: () => void;
  readonly restore: () => void;
}

/** A medium that can be taken away silently and given back silently. See {@link Severable}. */
export const severable = (): Severable => {
  let carrying = true;
  const open = new Set<{ alive: boolean }>();
  return {
    carrying: () => carrying,
    linked: () => {
      const link = { alive: true };
      open.add(link);
      return () => carrying && link.alive;
    },
    sever: () => {
      carrying = false;
      // latched here rather than read later: a link opened after the restore is a new link, and
      // the ones that were standing are what a severance abandons
      for (const link of open) link.alive = false;
      open.clear();
    },
    restore: () => void (carrying = true),
  };
};

/**
 * One stream over a medium that can be taken away — the shape every stream medium needs, written
 * once because a LAN connection and a Wi-Fi Aware data path are the same object.
 *
 * While the medium is gone the write is accepted and carried nowhere, arrivals stop, and no close
 * or error reaches either end. **The write does not throw**, which reads like a violation of
 * RFC-0005 and is the fault under test: a socket whose interface went away hands its bytes to a
 * kernel that will never send them and returns normally, so there is nothing for the layer above
 * to catch. A stream muted this way stays muted after {@link Severable.restore}, because the
 * connection an interface took with it does not come back when the interface does.
 */
export const severableStream = (stream: ByteStream, medium: Severable): ByteStream => {
  const carrying = medium.linked();
  return {
    write: (bytes) => {
      if (carrying()) stream.write(bytes);
    },
    onData: (cb) =>
      stream.onData((bytes) => {
        if (carrying()) cb(bytes);
      }),
    onClose: (cb) => stream.onClose(cb),
    close: () => stream.close(),
  };
};

/** Connects the peers in a chain — peer i talks only to i−1 and i+1; ends never meet directly. */
export type Connect = (peers: readonly SuitePeer[]) => Promise<SuiteNetwork>;

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; naming rules are not under test */
const NOTES = "notes" as TableName;
const ID = "id" as ColumnName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
export const rowKey = (k: string) => k as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();

const schema = syncSchema({
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

export const buildPeer = (n: number, startMs: number): SuitePeer => {
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

export const write = (peer: SuitePeer, id: string, body: string) =>
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
export const bodyOf = (peer: SuitePeer, id: string): string | undefined => {
  const value = readRow(peer.engine.state(), NOTES, rowKey(id))?.get(BODY);
  // SAFETY: the suite is the only writer of this table, and it writes body as text
  return value as string | undefined;
};

/**
 * Settle rounds a severed medium is given before the write it swallowed is called lost.
 *
 * Generous on purpose: a transport whose only way of noticing is a liveness deadline has to be
 * given the deadline, and this is the one place that decides how long "recovers by itself" may
 * take. What it is not is unbounded. A transport that recovers when a person relaunches the app
 * recovers, eventually, in a test that waits for ever — and that is the incident rather than the
 * contract.
 */
export const RECOVERY_ROUNDS = 20;

/**
 * Settle rounds a *nudged* severance gets: too few to wait out any deadline worth the name.
 *
 * The gap between this number and {@link RECOVERY_ROUNDS} is the whole value of `wake` — the
 * difference between a transport that was told the network moved and one left to notice.
 */
export const NUDGED_ROUNDS = 4;

/** Settles until `held`, or until the rounds run out; whether it held by then is the answer. */
export const settleUntil = async (
  network: SuiteNetwork,
  rounds: number,
  held: () => boolean,
): Promise<boolean> => {
  for (let round = 0; round < rounds; round += 1) {
    if (held()) return true;
    await network.settle();
  }
  return held();
};

/** Both halves of a severance, or nothing: a medium declaring one of them declares neither. */
export const severance = (network: SuiteNetwork) => {
  const chaos = network.chaos;
  if (chaos?.sever === undefined || chaos.restore === undefined) return undefined;
  return { sever: chaos.sever, restore: chaos.restore, resyncAll: chaos.resyncAll };
};
