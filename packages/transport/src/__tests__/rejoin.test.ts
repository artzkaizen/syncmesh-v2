import type { Cursors, Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { LineageCellRefused } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { JoinPolicy } from "../join.js";

import { belowPeerFloor, createRejoins } from "../rejoin.js";
import { peer } from "./fixtures.js";

/**
 * The receiver half of D46, without a link: what a session does with a peer's floor, and what
 * the mesh's ledger remembers across sessions. The end-to-end scenario is
 * `resurrection.test.ts`; these pin the rules it rests on one at a time.
 */

const cursors = (...pairs: readonly (readonly [PeerId, number])[]): Cursors =>
  // SAFETY: test fixture; the numbers are written as sequence numbers
  new Map(pairs.map(([author, seq]) => [author, seq as SeqNum]));

const device = peer(80, "acct_x");
const far = peer(40, "acct_b").identity.peerId;
const author = peer(120, "acct_c").identity.peerId;
const self = device.identity.peerId;

/** A session over the device's engine that records each request instead of sending it. */
const sessionWith = (
  rejoins: ReturnType<typeof createRejoins>,
  trusted: boolean,
  asked: { interest: Interest | undefined; policy: JoinPolicy }[],
  engine = device.engine,
) =>
  rejoins.session({
    engine,
    trusted,
    request: (interest, policy) => void asked.push({ interest, policy }),
  });

describe("belowPeerFloor", () => {
  test("below means strictly under the floor; at the floor everything removed is held", () => {
    expect(
      belowPeerFloor(self, cursors([author, 4]), cursors([author, 9]), cursors([author, 5])),
    ).toEqual(cursors([author, 5]));
    expect(
      belowPeerFloor(self, cursors([author, 5]), cursors([author, 9]), cursors([author, 5])).size,
    ).toBe(0);
  });

  test("a floor above the sender's own cursor is ignored: it cannot have removed what it never held", () => {
    expect(belowPeerFloor(self, new Map(), cursors([author, 3]), cursors([author, 5])).size).toBe(
      0,
    );
    // and a frame with no cursors at all, a repage's, makes every entry such a floor
    expect(belowPeerFloor(self, new Map(), new Map(), cursors([author, 5])).size).toBe(0);
  });

  test("this device's own author is never a reason to ask for state", () => {
    expect(belowPeerFloor(self, new Map(), cursors([self, 9]), cursors([self, 5])).size).toBe(0);
  });
});

describe("a session below a peer's floor", () => {
  const theirs = cursors([author, 9]);
  const floor = cursors([author, 5]);

  test("an older build's cursors frame, with no floor, asks nothing and raises nothing", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, true, asked);
    session.onCursors(far, theirs, undefined);
    session.onCursors(far, theirs, new Map());
    expect(asked).toEqual([]);
    expect(rejoins.issues()).toEqual([]);
    session.close();
  });

  test("trusted: one request per floor per session, under the claimed floor and no unvouched adoption", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, true, asked);
    session.onCursors(far, theirs, floor);
    session.onCursors(far, theirs, floor);
    expect(asked.map(({ policy }) => ({ ...policy, settled: undefined }))).toEqual([
      { adoptUnvouched: false, floor, settled: undefined },
    ]);
    // a floor that moved is a new claim, and earns one more request
    session.onCursors(far, cursors([author, 9]), cursors([author, 7]));
    expect(asked).toHaveLength(2);
    session.close();
  });

  test("an ignored floor in a repage frame does not use up the once-per-floor guard", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, true, asked);
    session.onCursors(far, new Map(), floor);
    expect(asked).toEqual([]);
    session.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(1);
    session.close();
  });

  test("three sessions asked with no install completed: the fourth raises the issue instead", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = sessionWith(rejoins, true, asked);
      session.onCursors(far, theirs, floor);
      session.close(); // the link dropped with the exchange still open
    }
    expect(asked).toHaveLength(3);
    expect(rejoins.issues()).toEqual([]);
    const fourth = sessionWith(rejoins, true, asked);
    fourth.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(3);
    expect(rejoins.issues()).toMatchObject([{ peer: far, reason: "unanswered" }]);
    fourth.close();
  });

  test("an install that leaves authors below raises the issue and stops asking that peer", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, true, asked);
    session.onCursors(far, theirs, floor);
    // vouched, but the sender withheld the run this device is below (D24): coverage did not move
    asked[0]?.policy.settled?.({
      kind: "installed",
      installed: { rows: 0, provisional: false },
      vouched: true,
    });
    expect(rejoins.issues()).toEqual([
      { peer: far, floor, reason: "incomplete", message: expect.any(String) },
    ]);
    session.onCursors(far, cursors([author, 9]), cursors([author, 7]));
    expect(asked).toHaveLength(1);
    session.close();
  });

  test("untrusted: nothing is asked until the app accepts, and an accepted floor asks on the next session", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const first = sessionWith(rejoins, false, asked);
    first.onCursors(far, theirs, floor);
    expect(asked).toEqual([]);
    expect(rejoins.issues().map(({ reason }) => reason)).toEqual(["untrusted"]);
    first.close();

    // no session open to that peer: the acceptance waits for one, and the device is still below
    expect(rejoins.accept(far)).toBe("deferred");
    expect(rejoins.issues().map(({ reason }) => reason)).toEqual(["untrusted"]);
    const second = sessionWith(rejoins, false, asked);
    second.onCursors(far, theirs, floor);
    expect(asked.map(({ policy }) => ({ ...policy, settled: undefined }))).toEqual([
      { adoptUnvouched: true, floor, settled: undefined },
    ]);
    second.close();
  });

  test("a second accept while the accepted request is open puts nothing more on the wire", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, false, asked);
    session.onCursors(far, theirs, floor);
    expect(rejoins.accept(far)).toBe("requested");
    expect(rejoins.accept(far)).toBe("requested");
    expect(asked).toHaveLength(1);
    session.close();
  });

  test("an accepted floor still holds for the authors a partial catch-up left below it", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const own = peer(83, "acct_w");
    const other = peer(121, "acct_d").identity.peerId;
    const both = cursors([author, 5], [other, 5]);
    const theirsBoth = cursors([author, 9], [other, 9]);
    const first = sessionWith(rejoins, false, asked, own.engine);
    first.onCursors(far, theirsBoth, both);
    first.close();
    expect(rejoins.accept(far)).toBe("deferred");

    // one author's run reached this device some other way; the other is still below the floor
    own.engine.adoptCoverage({ synced: cursors([author, 5]), local: new Map() });
    const second = sessionWith(rejoins, false, asked, own.engine);
    second.onCursors(far, theirsBoth, both);
    expect(asked.map(({ policy }) => ({ ...policy, settled: undefined }))).toEqual([
      { adoptUnvouched: true, floor: cursors([other, 5]), settled: undefined },
    ]);
    expect(rejoins.issues().map(({ reason }) => reason)).toEqual(["untrusted"]);
    second.close();
  });

  test("a refused install is an unanswered ask: it does not reset the count, and three raise the issue", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = sessionWith(rejoins, true, asked);
      session.onCursors(far, theirs, floor);
      asked.at(-1)?.policy.settled?.({
        kind: "refused",
        refused: new LineageCellRefused({
          table: "notes",
          key: "n1",
          column: "body",
          version: null,
          message: "bad cell",
        }),
      });
      expect(rejoins.issues()).toEqual([]);
      session.close();
    }
    const fourth = sessionWith(rejoins, true, asked);
    fourth.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(3);
    expect(rejoins.issues().map(({ reason }) => reason)).toEqual(["unanswered"]);
    fourth.close();
  });

  test("an install that left the device below one floor is not asked again by a later session", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const first = sessionWith(rejoins, true, asked);
    first.onCursors(far, theirs, floor);
    asked[0]?.policy.settled?.({
      kind: "installed",
      installed: { rows: 3, provisional: true },
      vouched: false,
    });
    first.close();
    expect(rejoins.issues().map(({ reason }) => reason)).toEqual(["unvouched"]);
    const second = sessionWith(rejoins, true, asked);
    second.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(1);
    // a floor that moved is a new claim and is asked for
    second.onCursors(far, theirs, cursors([author, 7]));
    expect(asked).toHaveLength(2);
    second.close();
  });

  test("two links to one peer put one request on the wire, and count it once", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const lan = sessionWith(rejoins, true, asked);
    const radio = sessionWith(rejoins, true, asked);
    lan.onCursors(far, theirs, floor);
    radio.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(1);
    // the asking link dropped: the other one asks, as the second of three
    lan.close();
    radio.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(2);
    radio.close();
    const third = sessionWith(rejoins, true, asked);
    third.onCursors(far, theirs, floor);
    expect(asked).toHaveLength(3);
    third.close();
  });

  test("a change is told when an issue is raised and when it clears on its own", async () => {
    const rejoins = createRejoins();
    const own = peer(82, "acct_z");
    let told = 0;
    const off = rejoins.onChange(() => (told += 1));
    const session = sessionWith(rejoins, false, [], own.engine);
    session.onCursors(far, cursors([author, 9]), cursors([author, 5]));
    expect(told).toBe(1);
    own.engine.adoptCoverage({ synced: cursors([author, 5]), local: new Map() });
    expect(rejoins.issues()).toEqual([]);
    await Promise.resolve();
    expect(told).toBe(2);
    off();
    session.close();
  });

  test("an issue clears on its own once this device is no longer below", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const own = peer(81, "acct_y");
    const session = sessionWith(rejoins, false, asked, own.engine);
    session.onCursors(far, cursors([author, 9]), cursors([author, 5]));
    expect(rejoins.issues()).toHaveLength(1);
    // the author's run reached this device some other way, up to the floor
    own.engine.adoptCoverage({ synced: cursors([author, 5]), local: new Map() });
    expect(rejoins.issues()).toEqual([]);
    expect(rejoins.accept(far)).toBe("nothing-to-accept");
    session.close();
  });
});

describe("a relay's retention refusal (gaps U30)", () => {
  test("is listed beside the peers' issues, and goes once the next join would hold the floor", () => {
    const rejoins = createRejoins();
    let next = cursors([author, 1]);
    const told: string[] = [];
    rejoins.onChange(() => told.push("changed"));
    rejoins.relayRefused("relay", cursors([author, 4]), () => next);
    expect(rejoins.issues()).toMatchObject([
      { relay: "relay", reason: "retention", floor: cursors([author, 4]) },
    ]);
    // a relay folds nothing: there is no state to accept from it
    expect(rejoins.accept(far)).toBe("nothing-to-accept");
    next = cursors([author, 4]);
    expect(rejoins.issues()).toEqual([]);
    rejoins.relayRefused("relay", cursors([author, 6]), () => next);
    rejoins.relayCleared("relay");
    expect(rejoins.issues()).toEqual([]);
    expect(told).toEqual(["changed", "changed", "changed"]);
  });
});

/**
 * A floor a relay passed on (gaps U52): the room carries cursors and events but no state, so a
 * device that reaches the peer only through it was never told it is below that peer's floor.
 */
describe("a peer's floor heard through a relay", () => {
  const theirs = cursors([author, 9]);
  const floor = cursors([author, 5]);
  /** This device's engine, as far as the record reads it: who it is and what it holds. */
  const holding = (held: () => Cursors) =>
    ({
      peerId: self,
      coverage: () => ({ synced: held(), local: new Map() }),
    }) satisfies Pick<Engine, "peerId" | "coverage">;
  const nothing = holding(() => new Map());

  test("raises a relayed issue, once per floor, and a moved floor replaces it", () => {
    const rejoins = createRejoins();
    let changes = 0;
    rejoins.onChange(() => (changes += 1));
    rejoins.relayedFloor(nothing, far, theirs, floor);
    rejoins.relayedFloor(nothing, far, theirs, floor);
    expect(rejoins.issues()).toMatchObject([{ peer: far, reason: "relayed", floor }]);
    expect(changes).toBe(1);
    rejoins.relayedFloor(nothing, far, theirs, cursors([author, 7]));
    expect(rejoins.issues()).toMatchObject([{ peer: far, floor: cursors([author, 7]) }]);
    expect(changes).toBe(2);
  });

  test("goes once this device catches up, however it got there", () => {
    const rejoins = createRejoins();
    let held = cursors();
    rejoins.relayedFloor(
      holding(() => held),
      far,
      theirs,
      floor,
    );
    expect(rejoins.issues()).toHaveLength(1);
    held = cursors([author, 5]);
    expect(rejoins.issues()).toEqual([]);
  });

  test("a link of this device's own to the peer asks for the state itself, and its issue stands", () => {
    const rejoins = createRejoins();
    const asked: Parameters<typeof sessionWith>[2] = [];
    const session = sessionWith(rejoins, false, asked);
    session.onCursors(far, theirs, floor);
    expect(rejoins.issues()).toMatchObject([{ peer: far, reason: "untrusted" }]);
    rejoins.relayedFloor(nothing, far, theirs, cursors([author, 6]));
    expect(rejoins.issues()).toMatchObject([{ peer: far, reason: "untrusted", floor }]);
    session.close();
    // the link is gone and so is its session: the issue it raised is the better one and stays
    rejoins.relayedFloor(nothing, far, theirs, cursors([author, 6]));
    expect(rejoins.issues()).toMatchObject([{ peer: far, reason: "untrusted", floor }]);
  });

  test("a floor this device is not below raises nothing", () => {
    const rejoins = createRejoins();
    rejoins.relayedFloor(nothing, far, theirs, undefined);
    rejoins.relayedFloor(nothing, far, theirs, new Map());
    rejoins.relayedFloor(
      holding(() => floor),
      far,
      theirs,
      floor,
    );
    expect(rejoins.issues()).toEqual([]);
  });
});
