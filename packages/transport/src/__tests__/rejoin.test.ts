import type { Cursors, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

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
    expect(rejoins.issues().map(({ peer: who, reason }) => ({ who, reason }))).toEqual([
      { who: far, reason: "unanswered" },
    ]);
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

    // no session open to that peer: the acceptance waits for one
    expect(rejoins.accept(far)).toBe("deferred");
    expect(rejoins.issues()).toEqual([]);
    const second = sessionWith(rejoins, false, asked);
    second.onCursors(far, theirs, floor);
    expect(asked.map(({ policy }) => ({ ...policy, settled: undefined }))).toEqual([
      { adoptUnvouched: true, floor, settled: undefined },
    ]);
    second.close();
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
