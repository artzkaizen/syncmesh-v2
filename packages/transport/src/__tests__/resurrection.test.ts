import type { EngineOptions, FoldBatch } from "@syncmesh/engine";
import type { Procedure } from "@syncmesh/kernel";

import {
  createEngine,
  createMemoryEventStore,
  createMemoryStateStore,
  createValidator,
  interestKey,
} from "@syncmesh/engine";
import { createHlcClock, readRow } from "@syncmesh/kernel";
import { Temporal, addToInstant } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { Divergence } from "../divergence.js";
import type { TransportContext } from "../transport.js";

import { bridgeFramedLink } from "../bridge.js";
import { divergenceAgainst, tableNames } from "../divergence.js";
import { loopbackPair } from "../link.js";
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

/** One loopback session between two peers; `now` is read per exchange so acks age. */
const bridge = (
  x: Peer,
  y: Peer,
  now: () => Temporal.Instant,
  onDivergence: (report: Divergence) => void,
) => {
  const { a, b, control } = loopbackPair();
  const side = (p: Peer, link: typeof a) =>
    bridgeFramedLink(link, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now,
      onDivergence,
    });
  const bx = side(x, a);
  const by = side(y, b);
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await bx.flush();
      await by.flush();
    }
  };
  return { bx, by, settle, close: () => [bx.close(), by.close()] };
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
const rejoinBelowTheFloor = async () => {
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
  const back = bridge(x, b, clock, report);
  await back.settle();
  await bc.settle();
  await back.settle();

  return { x, b, c, back, bc, found, sightings, close: () => [back.close(), bc.close()] };
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
   * The gap: RFC-0015 §3 and D15 say a peer that returns below the floor "rejoins from state",
   * but nothing on the device does so of its own accord. The bridge's cursor frame carries no
   * floor, `divergenceAgainst` declines the comparison, and the holdback buffers b's tail for
   * ever; `joinIfEmpty` only fires on empty coverage and `$recovery.rebuild` is a manual call.
   *
   * Observed, with the scenario above and no explicit `requestSnapshot`: after three settle
   * rounds x still reads `n1` (`visible(x) === true`), x's cursor for b is `0`, b's cursor for
   * x is `1`, no bridge reported a divergence and no snapshot was requested by anyone. The only
   * peer that knows about floors is the relay (`relay/src/retention.ts` refuses a below-floor
   * join with a typed `retention` error); device to device, x simply keeps the row.
   */
  test.todo("x rejoining below the floor drops the row on its own — observed: x still holds n1, its cursor for b stays 0, nobody requests a snapshot", async () => {
    const s = await rejoinBelowTheFloor();
    expect(cursorFor(s.x, s.b)).toBe(1);
    expect(visible(s.x)).toBe(false);
    s.close();
  });
});
