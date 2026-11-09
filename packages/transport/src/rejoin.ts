import type { Cursors, Engine, Interest, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import { createHub } from "@syncmesh/engine";

import type {
  BelowFloor,
  BelowFloorReason,
  BelowPeerFloor,
  BelowRelayFloor,
} from "./below-floor.js";
import type { JoinOutcome, JoinPolicy } from "./join.js";

import { belowPeerFloor } from "./below-floor.js";

/**
 * Rejoining from state (D46). A peer that compacted says how far on every cursors frame — its
 * floor — and a device whose cursor is below it knows the history it lacks is in no log that
 * peer still has. Delta sync cannot reach it, so the device asks for state instead.
 *
 * **Who decides what the answer may adopt.** The floor is an unsigned claim, so it never buys
 * coverage on its own. With `trust` set the device asks at once and adopts only state the issuer
 * vouched for; anything less merges its rows and leaves a {@link BelowFloor} issue. With no
 * `trust` nothing could vouch for a snapshot, so the device does not ask at all: it raises the
 * issue and stays where it is until the app accepts it ({@link Rejoins.accept}), which asks and
 * adopts up to the claimed floor for the authors below it (decided 2026-11-08).
 *
 * **How often.** At most once per (peer, floor) per session, so a floor that does not move is
 * one request and not one per cursor exchange, and one at a time across every link to that peer.
 * A request still open when its session ends, or answered with state that was refused, counts as
 * unanswered; three sessions asked with no install completed raise the issue instead of a fourth
 * request. An install that completes and leaves the device below a floor ends the asking for that
 * floor in every later session too: the next request is the app's ({@link Rejoins.accept}) or a
 * floor that moved. All of it is kept here, by the mesh, and not persisted.
 */

/** What {@link Rejoins.accept} did. */
export type Accepted =
  /** A session to the peer is open and the request is on its way. */
  | "requested"
  /** No session to the peer is open: the next one that sees the same floor asks. */
  | "deferred"
  /** Nothing is waiting on that peer: no issue, or this device is no longer below it. */
  | "nothing-to-accept";

/**
 * The mesh's record of every peer this device is below, shared by every session so the count of
 * attempts outlives each one (D46). A bridge given none keeps its own.
 */
export interface Rejoins {
  /** The peers this device is still below, with why; an issue clears once its authors catch up. */
  readonly issues: () => readonly BelowFloor[];
  /** Fires when an issue is raised or cleared, including one that cleared because its authors caught up. */
  readonly onChange: (listener: () => void) => Unsubscribe;
  /**
   * Takes state from this peer although nothing vouched for it, adopting per author at most the
   * floor it claimed. The app's or the operator's call, never this library's: in a mesh with no
   * `trust` a peer that lies about its floor and its rows could otherwise make this device stop
   * fetching an author's real events. Applies to the floor named in the issue only; a peer that
   * moves its floor raises a new issue. Works in a mesh with `trust` too, on an `unvouched` issue:
   * the same override, the same cap. The issue stays raised until an install answers it.
   */
  readonly accept: (peer: PeerId) => Accepted;
  /** One session's view of the same record; the bridge builds one per link. */
  readonly session: (deps: RejoinSessionDeps) => RejoinSession;
  /**
   * A relay refused this device's join with `retention` (gaps U30): raises its issue, or replaces
   * it. `ours` reads what the device's next join would send, so the issue clears once that is at
   * or above the floor.
   */
  readonly relayRefused: (relay: string, floor: Cursors, ours: () => Cursors) => void;
  /** Drops a relay's issue: the link holds the floor, was served, or stopped. */
  readonly relayCleared: (relay: string) => void;
  /**
   * A peer's cursors frame came through a relay (gaps U52). When `engine`'s device is below its
   * floor ({@link belowPeerFloor}), the relay cannot carry the state that would answer it, so the
   * issue is raised as `relayed` — unless a link of this device's own reaches the peer, whose
   * session asks for that state itself, or that link already raised the peer's issue. A frame
   * with no floor (an older build, or no compaction) raises nothing. The issue goes, and
   * {@link Rejoins.onChange} fires, on the first of `engine`'s folds that brings this device up
   * to the floor.
   */
  readonly relayedFloor: (
    engine: Pick<Engine, "peerId" | "coverage" | "onFoldBatch">,
    peer: PeerId,
    theirs: Cursors,
    floor: Cursors | undefined,
  ) => void;
}

export interface RejoinSessionDeps {
  readonly engine: Engine;
  /** The slice this link syncs: a device that joined with an interest asks with it. */
  readonly interest?: Interest;
  /** Whether a certificate could vouch for state here at all: the mesh set `trust`. */
  readonly trusted: boolean;
  readonly request: (interest: Interest | undefined, policy: JoinPolicy) => void;
}

export interface RejoinSession {
  /** A cursors frame arrived from `peer`; `floor` absent is an older build or no compaction. */
  readonly onCursors: (peer: PeerId, theirs: Cursors, floor: Cursors | undefined) => void;
  readonly close: () => void;
}

/** A raised issue, with the reader of the cursors it is judged against. */
interface Raised<Issue extends BelowFloor> {
  readonly issue: Issue;
  readonly ours: () => Cursors;
}

/** Sessions asked per (peer, floor) before the issue is raised instead of a fourth request. */
const ASKS_PER_FLOOR = 3;

const floorKey = (peer: PeerId, floor: Cursors): string =>
  `${peer}|${[...floor]
    .map(([author, seq]) => `${author}:${seq}`)
    .sort()
    .join(",")}`;

const MESSAGES = {
  untrusted:
    "this mesh has no trust anchor, so nothing can vouch for that peer's state; accept it to take the state and adopt up to its floor",
  unvouched:
    "the peer's state carried no certificate this device trusts: its rows merged, the coverage did not move",
  incomplete:
    "the peer's state did not cover these authors up to its floor (withheld tables, a scope it does not hold, or document columns)",
  unanswered: "asked for state in three sessions and no install completed",
  relayed:
    "this peer's floor reached this device through a relay, which carries no state, and no link of this device's own reaches the peer: take state from a peer link to it (accept it to adopt up to its floor once one opens) or $recovery.rebuild",
} satisfies Record<BelowFloorReason, string>;

const RETENTION =
  "the relay has trimmed its history below these cursors and refused the join: take state from a peer that folds (a peer link, or $recovery.rebuild); the link dials that room again once this device holds the floor, or when it is woken";

/** What {@link relayedFloorRule} reads and writes of the mesh's record. */
interface RelayedFloorDeps {
  readonly raised: ReadonlyMap<PeerId, Raised<BelowPeerFloor>>;
  readonly live: ReadonlyMap<PeerId, unknown>;
  readonly raise: (
    peer: PeerId,
    floor: Cursors,
    reason: BelowFloorReason,
    ours: () => Cursors,
  ) => void;
  readonly sweep: () => boolean;
  readonly changes: { readonly emit: () => void };
}

/**
 * {@link Rejoins.relayedFloor} over the record's parts. While a `relayed` issue stands it holds
 * the engine's fold subscription and sweeps on it: a relay-only device has no session whose sweep
 * would say the issue went.
 */
const relayedFloorRule = ({
  raised,
  live,
  raise,
  sweep,
  changes,
}: RelayedFloorDeps): Rejoins["relayedFloor"] => {
  let offFolds: Unsubscribe | undefined;
  const standing = () => [...raised.values()].some(({ issue }) => issue.reason === "relayed");
  return (engine, peer, theirs, floor) => {
    if (floor === undefined) return;
    const below = belowPeerFloor(engine.peerId, engine.coverage().synced, theirs, floor);
    if (below.size === 0 || live.has(peer)) return;
    const held = raised.get(peer)?.issue;
    // a link of this device's own judged that peer already: its reason is the better one
    if (held !== undefined && held.reason !== "relayed") return;
    if (held !== undefined && floorKey(peer, held.floor) === floorKey(peer, below)) return;
    raise(peer, below, "relayed", () => engine.coverage().synced);
    offFolds ??= engine.onFoldBatch(() => {
      if (sweep()) changes.emit();
      if (standing()) return;
      offFolds?.();
      offFolds = undefined;
    });
  };
};

export function createRejoins(): Rejoins {
  const changes = createHub<void>();
  /** Raised issues, one per peer, with the coverage reader of the session that raised it. */
  const raised = new Map<PeerId, Raised<BelowPeerFloor>>();
  /** Relays that refused this device with `retention`, one issue per relay (gaps U30). */
  const relays = new Map<string, Raised<BelowRelayFloor>>();
  /** Sessions asked per (peer, floor) with no install completed. */
  const attempts = new Map<string, number>();
  /**
   * (peer, floor) pairs with a request on the wire, and whether it was an accepted one, so a
   * second link to that peer, or a second `accept`, waits for it.
   */
  const inflight = new Map<string, boolean>();
  /** (peer, floor) pairs an install left below: no later session asks again on its own. */
  const halted = new Set<string>();
  /**
   * Floors the app accepted unvouched, per peer. A floor some of whose authors have since caught
   * up some other way is still the floor accepted for the rest, so it is matched per author.
   */
  const accepted = new Map<PeerId, Cursors>();
  /** Whether the app accepted every author of `below` at the floor it names. */
  const consented = (peer: PeerId, below: Cursors): boolean => {
    const floor = accepted.get(peer);
    return floor !== undefined && [...below].every(([author, seq]) => floor.get(author) === seq);
  };
  /** Open sessions per peer, each able to send an accepted request now. */
  const live = new Map<PeerId, Set<(floor: Cursors) => void>>();

  /** Whether any author of the issue is still below its floor. */
  const stillBelow = ({ issue, ours }: Raised<BelowFloor>): boolean => {
    const held = ours();
    return [...issue.floor].some(([author, seq]) => (held.get(author) ?? 0) < seq);
  };

  const raise = (peer: PeerId, floor: Cursors, reason: BelowFloorReason, ours: () => Cursors) => {
    raised.set(peer, { issue: { peer, floor, reason, message: MESSAGES[reason] }, ours });
    changes.emit();
  };

  const clear = (peer: PeerId): void => {
    if (raised.delete(peer)) changes.emit();
  };

  /** Drops every issue whose authors caught up; whether any went. */
  const sweep = (): boolean => {
    let dropped = false;
    for (const [peer, held] of raised)
      if (!stillBelow(held)) dropped = raised.delete(peer) || dropped;
    for (const [relay, held] of relays)
      if (!stillBelow(held)) dropped = relays.delete(relay) || dropped;
    return dropped;
  };

  const session = (deps: RejoinSessionDeps): RejoinSession => {
    const { engine, interest, trusted, request } = deps;
    const self = engine.peerId;
    const ours = () => engine.coverage().synced;
    /** (peer, floor) pairs this session already acted on. */
    const acted = new Set<string>();
    /** Peers this session stopped asking: an install left it below, and the issue says so. */
    const stopped = new Set<PeerId>();
    /** Requests this session put on the wire and has not heard back on. */
    const mine = new Set<string>();
    const registered = new Map<PeerId, (floor: Cursors) => void>();
    // an author's run can reach this device some other way; its issue goes when it does
    const offFolds = engine.onFoldBatch(() => {
      if (sweep()) changes.emit();
    });

    const ask = (peer: PeerId, below: Cursors, adoptUnvouched: boolean): void => {
      const key = floorKey(peer, below);
      inflight.set(key, adoptUnvouched);
      mine.add(key);
      const settled = (outcome: JoinOutcome): void => {
        inflight.delete(key);
        mine.delete(key);
        // a refused install merged nothing and completed nothing: it stays an unanswered ask
        if (outcome.kind === "refused") return;
        attempts.delete(key);
        if (adoptUnvouched) accepted.delete(peer);
        const left = belowPeerFloor(self, ours(), below, below);
        if (left.size === 0) return clear(peer);
        stopped.add(peer);
        halted.add(key);
        const reason = outcome.vouched || adoptUnvouched ? "incomplete" : "unvouched";
        raise(peer, left, reason, ours);
      };
      request(interest, { adoptUnvouched, floor: below, settled });
    };

    /** Makes this session one `accept` can send an accepted request over now. */
    const register = (peer: PeerId): void => {
      if (registered.has(peer)) return;
      const now = (below: Cursors) => {
        const key = floorKey(peer, below);
        acted.add(key);
        // an accepted request for this floor is already on the wire: its answer is this one's
        if (inflight.get(key) === true) return;
        ask(peer, below, true);
      };
      registered.set(peer, now);
      const sessions = live.get(peer) ?? new Set();
      sessions.add(now);
      live.set(peer, sessions);
    };

    const onCursors = (peer: PeerId, theirs: Cursors, floor: Cursors | undefined): void => {
      register(peer);
      const held = raised.get(peer);
      if (held !== undefined && !stillBelow(held)) clear(peer);
      if (floor === undefined || floor.size === 0) return;
      const below = belowPeerFloor(self, ours(), theirs, floor);
      // nothing below, or every entry ignored (a repage frame carries no cursors): no guard used
      if (below.size === 0) return;
      const key = floorKey(peer, below);
      // another link to the same peer already asked: its answer is this one's too
      if (acted.has(key) || inflight.has(key)) return;
      if (consented(peer, below)) {
        acted.add(key);
        return ask(peer, below, true);
      }
      if (stopped.has(peer) || halted.has(key)) return;
      acted.add(key);
      if (!trusted) return raise(peer, below, "untrusted", ours);
      const asked = attempts.get(key) ?? 0;
      if (asked >= ASKS_PER_FLOOR) return raise(peer, below, "unanswered", ours);
      attempts.set(key, asked + 1);
      ask(peer, below, false);
    };

    return {
      onCursors,
      close: () => {
        offFolds();
        // a request still open when its session ends counts as never answered
        for (const key of mine) inflight.delete(key);
        mine.clear();
        for (const [peer, now] of registered) {
          const sessions = live.get(peer);
          sessions?.delete(now);
          if (sessions?.size === 0) live.delete(peer);
        }
        registered.clear();
      },
    };
  };

  return {
    issues: () => {
      // read from a getter a renderer calls: the change is told after it, never inside it
      if (sweep()) queueMicrotask(() => changes.emit());
      return [...raised.values(), ...relays.values()].map(({ issue }) => issue);
    },
    onChange: (listener) => changes.subscribe(() => listener()),
    accept: (peer) => {
      const held = raised.get(peer);
      if (held === undefined || !stillBelow(held)) {
        clear(peer);
        return "nothing-to-accept";
      }
      const { floor } = held.issue;
      accepted.set(peer, floor);
      // the issue stays until an install answers it: accepting is not yet being caught up
      const sessions = live.get(peer);
      const first = sessions === undefined ? undefined : [...sessions][0];
      if (first === undefined) return "deferred";
      first(floor);
      return "requested";
    },
    session,
    relayRefused: (relay, floor, ours) => {
      relays.set(relay, { issue: { relay, floor, reason: "retention", message: RETENTION }, ours });
      changes.emit();
    },
    relayCleared: (relay) => {
      if (relays.delete(relay)) changes.emit();
    },
    relayedFloor: relayedFloorRule({ raised, live, raise, sweep, changes }),
  };
}
