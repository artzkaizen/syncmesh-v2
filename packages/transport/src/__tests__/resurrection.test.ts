import type { EngineOptions, FoldBatch } from "@syncmesh/engine";
import type { Procedure, SeqNum } from "@syncmesh/kernel";

import {
  createEngine,
  createMemoryEventStore,
  createMemoryStateStore,
  createValidator,
  interestKey,
} from "@syncmesh/engine";
import { createHlcClock, readRow } from "@syncmesh/kernel";
import { Temporal, addToInstant } from "@syncmesh/temporal";
import {
  checkpointHash,
  createGrantRegistry,
  createIdentity,
  encodeRecord,
  issueCheckpoint,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { BridgeOptions } from "../bridge.js";
import type { Divergence } from "../divergence.js";
import type { SnapshotInstalled } from "../join.js";
import type { TransportContext } from "../transport.js";

import { bridgeFramedLink } from "../bridge.js";
import { divergenceAgainst, tableNames } from "../divergence.js";
import { decodeFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { createRejoins } from "../rejoin.js";
import { ACME, ISSUER, NOTES, T0, key, mintFor, schema, seed, write } from "./fixtures.js";

/**
 * Delete-resurrection, pinned (plan/api-gaps.md §3.5).
 *
 * The bug class: a device offline past the tombstone TTL rejoins and brings a deleted row back,
 * because the delete it never saw has been purged everywhere. The claim is that this cannot
 * happen here by construction. The tombstone lives in **state**, not in the log — compaction
 * only ever removes log below what the state store has persisted (D15; `engine/src/compaction.ts`:
 * "below a compaction floor the folded state is not a cache of the log: it is the only copy"),
 * so a peer past the floor still holds the delete stamp, and every path a stale row can arrive
 * by — an event, a repair, a snapshot — goes through the same max-based merge, in which a newer
 * delete stamp wins (`engine/src/snapshot.ts`: "unable to resurrect a tombstone"). A peer that
 * returns below the floor cannot delta-sync and "rejoins from state" (RFC-0015 §3).
 *
 * Three peers in a chain, x — b — c. x folds a row of its own, goes dark, b deletes it, b and c
 * compact past the delete under `forgetPeersAfter`, and x comes back. Every log has forgotten
 * the delete; only b's and c's state remember it. Bridges are the real ones over loopback, so
 * the cursor exchange, the holdback and the digest exchange are what a device actually runs.
 */

const DAY = Temporal.Duration.from({ days: 1 });
const N1 = key("n1");
// SAFETY: test fixture; procedure naming rules arrive with the client
const DELETE = "notes.delete" as Procedure;

/** A granted peer whose engine can compact: the suite's `peer()`, plus the state store D15 needs. */
const peerWithState = (n: number, account: string, startMs: number) => {
  const identity = createIdentity(seed(n)).unwrap();
  const grants = createGrantRegistry({ issuer: ISSUER.peerId, now: () => T0 });
  grants.register(mintFor(identity, account)).unwrap();
  let ms = startMs;
  const store = createMemoryEventStore();
  const options: EngineOptions = {
    peerId: identity.peerId,
    clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) }),
    store,
    stateStore: createMemoryStateStore(),
    validate: createValidator({ schema, grantFor: (p) => grants.grantFor(p) }),
  };
  const engine = createEngine(options);
  const context: TransportContext = { engine, identity, grants, now: () => T0 };
  return { identity, grants, store, engine, context };
};

type Peer = ReturnType<typeof peerWithState>;

/** One fold that touched `n1` on a peer that had deleted it, and whether the row was visible after. */
interface Sighting {
  readonly peer: string;
  readonly source: FoldBatch["source"];
  readonly visible: boolean;
}

/** What each side of one session runs with beyond the basics, given the peer it runs on. */
interface Sides {
  readonly x?: (self: Peer) => Partial<BridgeOptions>;
  readonly y?: (self: Peer) => Partial<BridgeOptions>;
}

/** One loopback session between two peers; `now` is read per exchange so acks age. */
const bridge = (
  x: Peer,
  y: Peer,
  now: () => Temporal.Instant,
  onDivergence: (report: Divergence) => void,
  sides: Sides = {},
) => {
  const { a, b, control } = loopbackPair();
  /** Every snapshot request x sent on this session. */
  const asked: string[] = [];
  const counting = {
    ...a,
    send: (bytes: Uint8Array) => {
      const frame = decodeFrame(bytes);
      if (frame.isOk() && frame.value.kind === "snap-req") asked.push(frame.value.kind);
      a.send(bytes);
    },
  };
  const side = (p: Peer, link: typeof a, extra: Partial<BridgeOptions> = {}) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now,
      onDivergence,
      ...extra,
    });
  const bx = side(x, counting, sides.x?.(x));
  const by = side(y, b, sides.y?.(y));
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, settle, asked, close: () => [bx.close(), by.close()] };
};

const visible = (p: Peer, k = N1) => readRow(p.engine.state(), NOTES, k) !== undefined;
const cursorFor = (p: Peer, author: Peer) =>
  Number(p.engine.coverage().synced.get(author.identity.peerId) ?? 0);
const logHolds = async (p: Peer, author: Peer) =>
  (await p.store.all()).unwrap().filter(({ event }) => event.peerId === author.identity.peerId)
    .length;

/**
 * The scenario up to the moment x is back on a session with b, shared by every case below.
 *
 * Hands back the peers, every fold on b or c that touched the row since the delete, every
 * divergence any bridge reported, and the x—b session x rejoined on.
 */
const rejoinBelowTheFloor = async (sides: Sides = {}) => {
  const x = peerWithState(40, "acct_x", 100);
  const b = peerWithState(80, "acct_b", 500);
  const c = peerWithState(120, "acct_c", 900);
  let now = T0;
  const clock = () => now;
  const found: Divergence[] = [];
  const report = (d: Divergence) => void found.push(d);
  const sightings: Sighting[] = [];
  const watch = (p: Peer, name: string) =>
    p.engine.onFoldBatch((batch) => {
      if (batch.writeKeys.get(NOTES)?.has(N1) !== true) return;
      sightings.push({ peer: name, source: batch.source, visible: visible(p) });
    });

  // x's row reaches everyone
  const xb = bridge(x, b, clock, report);
  const bc = bridge(b, c, clock, report);
  (await write(x, "n1", "from x")).unwrap();
  await xb.settle();
  await bc.settle();
  expect([x, b, c].map((p) => visible(p))).toEqual([true, true, true]);

  // x goes dark; two days pass; b deletes the row and b and c exchange cursors over it
  xb.close();
  watch(b, "b");
  watch(c, "c");
  now = addToInstant(T0, Temporal.Duration.from({ days: 2 }));
  (await b.engine.mutate(DELETE, (tx) => tx.delete(NOTES, N1), { partition: ACME })).unwrap();
  bc.bx.resync();
  bc.by.resync();
  await bc.settle();
  expect([b, c].map((p) => visible(p))).toEqual([false, false]);
  expect(b.engine.deletedAt(NOTES, N1)).toBeDefined();
  expect(c.engine.deletedAt(NOTES, N1)).toBeDefined();

  // compaction past the delete: x, silent for two days, no longer pins the floor (D15)
  (await b.engine.compact({ now, forgetPeersAfter: DAY })).unwrap();
  (await c.engine.compact({ now, forgetPeersAfter: DAY })).unwrap();
  // the precondition of the bug: no log anywhere still carries the delete, and b's has
  // forgotten x's insert with it
  expect(await logHolds(b, b)).toBe(0);
  expect(await logHolds(c, b)).toBe(0);
  expect(await logHolds(b, x)).toBe(0);
  // the tombstone survives in state, which is the whole of the claim
  expect([b, c].map((p) => visible(p))).toEqual([false, false]);

  // x comes back on a fresh session, below b's floor
  const back = bridge(x, b, clock, report, sides);
  await back.settle();
  await bc.settle();
  await back.settle();

  return {
    x,
    b,
    c,
    back,
    bc,
    found,
    sightings,
    clock,
    report,
    close: () => [back.close(), bc.close()],
  };
};

describe("delete-resurrection — plan §3.5, D15, RFC-0015 §3", () => {
  /**
   * Every route a stale row could take into a peer past the floor, and none of them lands.
   *
   * A broken build shows up as one of: a sighting on b or c with `visible: true` (the row came
   * back through the session), a `Divergence` report followed by a `repair` fold that shows it,
   * or the direct re-offer / forced repair leaving `n1` readable on b with a changed digest.
   */
  test("a peer past the floor never shows the row again, by any route", async () => {
    const s = await rejoinBelowTheFloor();

    // the session route: x's rejoin folded nothing that made the row visible on b or c
    expect(s.sightings.every((seen) => !seen.visible)).toBe(true);
    expect([s.b, s.c].map((p) => visible(p))).toEqual([false, false]);

    // the repair route is closed at the door: x stands at a different coverage, so b will not
    // compare digests with it, and no bridge reported anything to repair
    const scope = interestKey({});
    const theirs = {
      scope,
      at: s.x.engine.coverage().synced,
      digests: tableNames(s.x.engine.digest()),
      ahead: s.x.engine.ahead(),
    };
    expect(s.x.engine.digest().get(NOTES)).not.toBe(s.b.engine.digest().get(NOTES));
    expect(divergenceAgainst(s.b.engine, undefined, scope, theirs)).toBeUndefined();
    expect(s.found).toEqual([]);

    // the event route, forced: b is handed x's original insert again. Compaction forgot the
    // event id, so the log cannot call it a duplicate — it is folded, not skipped — and the
    // row still does not come back, because the delete stamp already in state is newer
    const before = s.b.engine.digest().get(NOTES);
    const xLog = (await s.x.store.all()).unwrap();
    expect(xLog.map(({ event }) => event.peerId)).toEqual([s.x.identity.peerId]);
    const reoffer = (await s.b.engine.receiveBatch(xLog)).unwrap();
    expect(reoffer.quarantined).toBe(0);
    expect(visible(s.b)).toBe(false);
    expect(s.b.engine.digest().get(NOTES)).toBe(before);
    expect(cursorFor(s.b, s.x)).toBe(1);

    // the repair route, forced past its guard: x's record merged straight into b's state
    await s.b.engine.repairRows(NOTES, s.x.engine.rowRecords(NOTES, [N1]));
    expect(visible(s.b)).toBe(false);
    expect(s.b.engine.digest().get(NOTES)).toBe(before);
    expect(s.sightings.every((seen) => !seen.visible)).toBe(true);

    s.close();
  });

  /**
   * The other half of D15: below the floor x cannot delta-sync, and rejoining from state is
   * what removes its stale row and lets it sync again.
   *
   * A broken build shows up as `n1` still readable on x after the snapshot installed, or as x's
   * cursor for b left at 0 so b's later writes never arrive.
   */
  test("x rejoins from state: the row is gone everywhere and x delta-syncs again", async () => {
    const s = await rejoinBelowTheFloor();

    // below the floor: the delete x needs is in no log, so b's later writes stall behind the
    // hole and x's cursor for b never moves — RFC-0015 §3's "cannot delta-sync"
    (await write(s.b, "n2", "from b")).unwrap();
    await s.back.settle();
    expect(cursorFor(s.x, s.b)).toBe(0);
    expect(visible(s.x, key("n2"))).toBe(false);

    // state instead of history: b's snapshot carries the tombstone, and installing it merges
    // the delete over x's stale row and adopts b's coverage
    s.back.bx.requestSnapshot();
    await s.back.settle();
    expect(visible(s.x)).toBe(false);
    expect(s.x.engine.deletedAt(NOTES, N1)).toBeDefined();
    expect(cursorFor(s.x, s.b)).toBe(2);
    expect(visible(s.x, key("n2"))).toBe(true);

    // and from here the ordinary path works again
    (await write(s.b, "n3", "from b")).unwrap();
    await s.back.settle();
    expect(cursorFor(s.x, s.b)).toBe(3);
    expect(visible(s.x, key("n3"))).toBe(true);
    expect([s.x, s.b, s.c].map((p) => visible(p))).toEqual([false, false, false]);
    expect(s.sightings.every((seen) => !seen.visible)).toBe(true);
    expect(s.found).toEqual([]);

    s.close();
  });

  /**
   * RFC-0015 §3 and D15 say a peer that returns below the floor "rejoins from state", and D46 is
   * what makes a device do so of its own accord: b's cursors frame carries its compaction floor,
   * x sees its cursor for b under it and asks b for state, and the issuer's certificate over b's
   * rows lets x adopt b's coverage.
   *
   * Before D46, observed with this scenario: x still read `n1`, its cursor for b stayed `0`, no
   * bridge reported a divergence and nobody requested a snapshot.
   */
  test("x rejoining below a vouched floor drops the row on its own and syncs again", async () => {
    const certified = (holder: Peer) => () =>
      issueCheckpoint(ISSUER, {
        stateHash: checkpointHash(
          holder.engine.snapshot().rows.map(({ table, key, record }) => ({
            table: String(table),
            key: String(key),
            record: encodeRecord(record),
          })),
        ),
        coverage: holder.engine.coverage().synced,
        now: T0,
      });
    const installed: SnapshotInstalled[] = [];
    const trusting = {
      trust: ISSUER.peerId,
      onSnapshot: (report: SnapshotInstalled) => void installed.push(report),
    };
    // the certificate is b's to relay, as a peer relays the authority's checkpoint
    const t = await rejoinBelowTheFloor({
      x: () => trusting,
      y: (b) => ({ certificate: certified(b) }),
    });
    expect(t.back.asked).toHaveLength(1);
    expect(installed).toEqual([{ rows: 1, provisional: false }]);
    expect(visible(t.x)).toBe(false);
    expect(t.x.engine.deletedAt(NOTES, N1)).toBeDefined();
    expect(cursorFor(t.x, t.b)).toBe(1);

    // and the ordinary path is open again: b's next write arrives as an event
    (await write(t.b, "n2", "from b")).unwrap();
    await t.back.settle();
    expect(cursorFor(t.x, t.b)).toBe(2);
    expect(visible(t.x, key("n2"))).toBe(true);
    expect(t.back.asked).toHaveLength(1);
    expect(t.found).toEqual([]);
    t.close();
  });

  /**
   * With no `trust` nothing can vouch for b's state, so x does not take it on b's word: it raises
   * the issue naming b and the floor and waits (decided 2026-11-08). Accepting the issue is what
   * asks, and what that install adopts is capped at the floor b claimed.
   */
  test("with no trust, x raises the issue and rejoins only once the app accepts it", async () => {
    const rejoins = createRejoins();
    const cursorsAtInstall: number[] = [];
    const s = await rejoinBelowTheFloor({ x: () => ({ rejoins }) });
    // b moves on past its floor while x waits: the snapshot will claim b:2, the floor says 1
    (await write(s.b, "n2", "from b")).unwrap();
    await s.back.settle();

    expect(s.back.asked).toEqual([]);
    expect(visible(s.x)).toBe(true);
    expect(cursorFor(s.x, s.b)).toBe(0);
    expect(rejoins.issues()).toEqual([
      {
        peer: s.b.identity.peerId,
        // SAFETY: b's own delete was its first write
        floor: new Map([[s.b.identity.peerId, 1 as SeqNum]]),
        reason: "untrusted",
        message: expect.any(String),
      },
    ]);
    // and asking again on every cursors exchange is not how it waits
    s.back.bx.resync();
    s.back.by.resync();
    await s.back.settle();
    expect(s.back.asked).toEqual([]);

    const off = s.x.engine.onFoldBatch((batch) => {
      if (batch.source === "snapshot") cursorsAtInstall.push(cursorFor(s.x, s.b));
    });
    expect(rejoins.accept(s.b.identity.peerId)).toBe("requested");
    await s.back.settle();
    off();
    expect(s.back.asked).toHaveLength(1);
    expect(visible(s.x)).toBe(false);
    // the install adopted b's claimed floor, 1, not the b:2 the snapshot claimed
    expect(cursorsAtInstall).toEqual([1]);
    expect(rejoins.issues()).toEqual([]);
    expect(rejoins.accept(s.b.identity.peerId)).toBe("nothing-to-accept");

    // and from there the ordinary path delivers b's write above the floor
    s.back.bx.resync();
    await s.back.settle();
    expect(cursorFor(s.x, s.b)).toBe(2);
    expect(visible(s.x, key("n2"))).toBe(true);
    s.close();
  });

  /**
   * The floor one hop on. x joined from a's state and holds a's coverage with none of a's log
   * behind it, so x cannot send that history either: its cursors frame says so, and y, behind
   * both, is told to ask for state rather than delta-syncing into a hole nothing fills.
   *
   * Before the fix, observed with this scenario: x's floor was empty, y's cursor for a stayed 1,
   * n2 never reached y and no issue was raised.
   */
  test("a device that joined from state advertises the coverage it holds no log for", async () => {
    const a = peerWithState(40, "acct_x", 100);
    const x = peerWithState(80, "acct_b", 500);
    const y = peerWithState(120, "acct_c", 900);
    const found: Divergence[] = [];
    const report = (d: Divergence) => void found.push(d);
    const ay = bridge(a, y, () => T0, report);
    (await write(a, "n1", "from a")).unwrap();
    await ay.settle();
    ay.close();
    for (const k of ["n2", "n3"]) (await write(a, k, `from a ${k}`)).unwrap();
    (await x.engine.installSnapshot(a.engine.snapshot())).unwrap();
    expect(cursorFor(x, a)).toBe(3);
    expect(await logHolds(x, a)).toBe(0);

    const rejoins = createRejoins();
    const yx = bridge(y, x, () => T0, report, { x: () => ({ rejoins }) });
    await yx.settle();
    expect(cursorFor(y, a)).toBe(1);
    expect(rejoins.issues()).toEqual([
      {
        peer: x.identity.peerId,
        // SAFETY: a's third write
        floor: new Map([[a.identity.peerId, 3 as SeqNum]]),
        reason: "untrusted",
        message: expect.any(String),
      },
    ]);
    expect(rejoins.accept(x.identity.peerId)).toBe("requested");
    await yx.settle();
    expect(cursorFor(y, a)).toBe(3);
    expect(visible(y, key("n2"))).toBe(true);
    expect(rejoins.issues()).toEqual([]);
    yx.close();
  });

  /**
   * With `trust` set and nothing vouching for b's state, x asks once, merges the rows — the
   * deleted row goes — adopts nothing, and says why it is still stalled.
   */
  test("with trust and no certificate, the rows merge, nothing is adopted, and the issue says so", async () => {
    const rejoins = createRejoins();
    const s = await rejoinBelowTheFloor({
      x: () => ({ rejoins, trust: ISSUER.peerId }),
    });
    expect(s.back.asked).toHaveLength(1);
    expect(visible(s.x)).toBe(false);
    expect(cursorFor(s.x, s.b)).toBe(0);
    expect(rejoins.issues().map(({ peer, reason }) => ({ peer, reason }))).toEqual([
      { peer: s.b.identity.peerId, reason: "unvouched" },
    ]);
    // one request per floor per session, however many cursor exchanges follow
    for (let round = 0; round < 3; round += 1) {
      s.back.bx.resync();
      s.back.by.resync();
      await s.back.settle();
    }
    expect(s.back.asked).toHaveLength(1);
    s.close();
  });
});
