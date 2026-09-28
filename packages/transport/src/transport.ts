import type { Engine, Interest, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { EventCrypto, GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub } from "@syncmesh/engine";
import { TaggedError, omitUndefined } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { Bridge, BridgeOptions } from "./bridge.js";
import type { AdmissionAsk } from "./gate.js";
import type { LinkEvent, LinkFact } from "./link-events.js";
import type { FrameLink } from "./link.js";
import type { TransportCondition, TransportKind } from "./medium.js";
import type { PeerSessions, SessionLink } from "./peer-session.js";
import type { RouteMessage } from "./route-scorer.js";
import type { RouteProfile } from "./route-scorer.js";
import type { RouteTable } from "./routes.js";
import type { Upgrader } from "./upgrade.js";

import { bridgeFramedLink } from "./bridge.js";
import { reportingUpgrader } from "./link-events.js";
import { createUpgrader } from "./upgrade.js";

/** Everything a transport needs to run sessions; `createMesh({ transports })` supplies it. */
export interface TransportContext {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly grants: GrantRegistry;
  readonly now?: () => Temporal.Instant;
  readonly onGrantRequest?: BridgeOptions["onGrantRequest"];
  /** Where arriving ephemeral values go (D16); absent, presence frames are ignored. */
  readonly onPresence?: BridgeOptions["onPresence"];
  /**
   * This device's storage lineage, which is what makes its custody signable (D28).
   *
   * Absent, this device vouches for nothing it holds — it still receives events and still
   * acknowledges them in its cursors, but no peer can count it as a signed holder. Which is the
   * honest outcome: a device that cannot say *which* store held the event is claiming custody it
   * has no way to lose.
   */
  readonly incarnation?: BridgeOptions["incarnation"];
  /**
   * A verified receipt for one of **this device's own** writes — somebody signed for holding it.
   * Absent, receipts are still checked on arrival and then dropped, which is what every link did
   * before the ledger had anywhere to put them.
   */
  readonly onReceipt?: BridgeOptions["onReceipt"];
  /**
   * A join completed on some link (RFC-0019): state arrived instead of history. What
   * `$recovery.rebuild` listens to, and what tells it whether anything vouched for the rows.
   */
  readonly onSnapshot?: BridgeOptions["onSnapshot"];
  /**
   * A checkpoint this device holds, offered alongside any state it serves (RFC-0019).
   *
   * Forwarded verbatim and never re-signed: a peer may pass on a certificate it could not itself
   * have minted, which is what lets state travel further than the authority that vouched for it.
   */
  readonly certificate?: BridgeOptions["certificate"];
  /**
   * Whose certificate this device will believe — the issuer from `trust`, exactly as grants use.
   *
   * Absent, arriving state is still installed but every install is provisional, because nothing
   * present could tell a vouched snapshot from an invented one.
   */
  readonly trust?: BridgeOptions["trust"];
  /**
   * Whether this transport is the one to carry a frame (E28). The mesh supplies it from
   * `pickRoutes`; a transport running without one carries everything, which is what every
   * transport did before link admission existed.
   */
  readonly carries?: (transport: string, message: RouteMessage) => boolean;
  /**
   * This device's routing table (book ch. 17), shared by every link. A transport passes it to
   * each bridge it builds; absent, nothing routes beyond one hop, which is what every medium
   * did before routes existed.
   */
  readonly routes?: RouteTable;
  /**
   * This device's sessions, one per peer (book ch. 16). A transport that has proved which peer
   * is on a link joins it here instead of building a bridge of its own, so three media reaching
   * one laptop are one conversation rather than three.
   *
   * Absent, every link gets its own bridge, which is what every medium did before peer sessions
   * existed and what a link whose peer is not yet known still does.
   */
  readonly sessions?: PeerSessions;
  /**
   * What this device can seal and open (book ch. 14), handed to every bridge it builds. Absent,
   * every event travels in the clear — which is what a mesh with no sealed partition does, and
   * what a relay does for a partition it holds no key for.
   */
  readonly crypto?: EventCrypto;
  /**
   * Whether a link to this peer may stand at all (book ch. 14) — the door, as against the budget,
   * which decides which of the links that did form are worth keeping.
   *
   * Asked **once per peer**, when the first link to it opens a session, and not once per link: a
   * device reachable over three media is one decision, and asking three times would let the
   * answers disagree. Absent, every link that formed stands, which is what every medium did
   * before there was a door.
   */
  readonly admits?: (ask: AdmissionAsk) => Promise<boolean>;
}

/**
 * Where a write sits in the log a store-and-forward hop keeps: which log, and how far into it.
 *
 * The lineage half matters as much as the position (RFC-0020 §3.2). An offset alone is a number
 * that means something different in every log, so a hop restarted over a fresh one would confirm
 * a write into a log that never held it. Carrying the lineage makes that case answerable —
 * {@link VisibilityLost} — instead of falsely settled.
 */
export interface VisibilityToken {
  /** The log's lineage id; a relay opened over a new log announces a new one. */
  readonly epoch: string;
  /** The position within *that* lineage. Monotone inside one, meaningless across two. */
  readonly offset: number;
}

/**
 * The log this token names is not the log this device is now reading — a relay restarted over a
 * fresh store, or a token from another room. The write it stands for is untouched: it is in this
 * device's own log, signed, and will be re-offered on the next join. Only the *question* is
 * unanswerable, because the position it asked about no longer exists.
 */
export class VisibilityLost extends TaggedError("VisibilityLost")<{
  /** The lineage the token was minted against. */
  expected: string;
  /** The lineage this device is reading instead — what makes the two logs nameable in a log line. */
  actual: string;
  message: string;
}> {}

/** The caller stopped waiting. The write is unaffected — ask again with a longer deadline. */
export class VisibilityTimeout extends TaggedError("VisibilityTimeout")<{
  offset: number;
  message: string;
}> {}

/**
 * Reading back what you just wrote (RFC-0020 §3.2, N1b). `synced()` answers *did the relay
 * durably take it?*; this answers *can I read it back yet?* — the question a UI asks after a
 * write it wants to draw as settled, and the one a server answers for a caller by handing the
 * token over so the caller can wait for its own device to arrive there.
 *
 * A capability, not an obligation: a radio has no ordered log to name a position in, so it
 * declares none and `mesh.visibility` answers a typed value rather than pretending.
 */
export interface TransportVisibility {
  /** How far this device has been told the log runs, in the lineage it was told under; `undefined` until a session has said. */
  readonly token: () => VisibilityToken | undefined;
  /**
   * Settles once this device has been told about a position at or past the token's, in the same
   * lineage — `VisibilityLost` when the lineage changed (including while waiting), and
   * `VisibilityTimeout` when the caller's deadline passed first. Default deadline 10s.
   */
  readonly visibleAt: (
    token: VisibilityToken,
    options?: { readonly timeoutMs?: number },
  ) => Promise<Result<void, VisibilityLost | VisibilityTimeout>>;
}

export interface DownloadBlobOptions {
  /** How long to wait for an answer before giving `undefined`. */
  readonly timeoutMs: number;
}

/**
 * Bytes crossing this medium out of band, by hash (D18): what a medium with a store on the far
 * side can carry. A capability, not an obligation — a raw radio has nobody to hand bytes to, so
 * it declares none and `mesh.blobs` answers `NoSuchCapability` rather than pretending (D30).
 */
export interface TransportBlobs {
  /** Offers bytes under their own hash; the far end verifies before it keeps them. */
  readonly upload: (hash: string, bytes: Uint8Array) => Promise<void>;
  /** Asks for bytes by hash; `undefined` when nobody there holds them, or the deadline passed. */
  readonly download: (
    hash: string,
    options: DownloadBlobOptions,
  ) => Promise<Uint8Array | undefined>;
}

/**
 * The two-tier port (D12-A): required `name/start/stop/whenReady`, optional capabilities.
 * An absent capability is a fact about the medium, not a bug.
 */
export interface Transport {
  readonly name: string;
  /**
   * Check the link now, because something outside knows it may have changed.
   *
   * **A socket does not always learn that its network went away.** Switch a phone's Wi-Fi off and
   * the TCP connection underneath is not closed so much as abandoned: no `close` event arrives, so
   * a transport that waits to be told is still holding what it believes is a live link. What
   * eventually notices is the keepalive deadline — 2.5× the relay's 15s — which means **up to
   * ~37 seconds** where writes queue locally and go nowhere after the network is back. That is not
   * broken forever, but for an app whose whole claim is that it catches up by itself it may as
   * well be: a person reaches for the reload long before 37 seconds are up.
   *
   * So this is the door for a platform that *does* know — an OS reachability callback, an app
   * returning to the foreground — to say "look again" and have the link re-established on the spot
   * rather than on a timeout. Optional because not every transport has a link that can go stale
   * without saying so, and calling it on a healthy one must be free.
   */
  readonly wake?: () => void;
  readonly start: (ctx: TransportContext) => Promise<void>;
  /** Resolves when the medium is usable — or after the force-ready timeout, so a dead network never wedges the mesh. */
  readonly whenReady: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /**
   * How near this source is (RFC-0019): `0` is the device's own storage, `1` a relay, `2` a
   * radio. Lower answers first, and a scope is not empty until the lower numbers have finished —
   * a fast radio that holds nothing must not be what tells the app there is nothing. Default 1.
   */
  readonly priority?: number;
  /**
   * What kind of medium this is, for the route scorer (RFC-0012 §2): direct or relayed, how
   * fast, whether it costs power out of proportion to the bytes it moves, whether its radio is
   * currently down. Read per send rather than declared once, because a radio renegotiates its
   * bandwidth and a dormant one wakes.
   *
   * Absent means {@link ORDINARY_LINK} — which is what a relay is, and why the relay says
   * nothing here.
   */
  readonly route?: () => RouteProfile;
  /**
   * The peers this medium currently has a link to (RFC-0012 §1, E28) — the fact that lets
   * `pickRoutes` choose one link rather than filter a broadcast.
   *
   * Optional, and absent is not "no peers": a medium that cannot enumerate its links says
   * nothing, and every frame keeps reaching it exactly as it does today. A transport that
   * answers must answer completely, because a peer it omits is a peer the mesh stops talking
   * to down this link.
   */
  readonly reaches?: () => ReadonlySet<PeerId>;
  /**
   * The peers this medium can get a frame *to*, which is not the same as the ones it has a link to.
   *
   * A relay holds exactly one link — to the server — and forty phones behind it. Those forty are
   * deliverable through this medium and are not adjacent to it, and the distinction is load-bearing
   * rather than pedantic: {@link reaches} is what `churn` counts against {@link maxLinks} before it
   * closes something, so a medium that answered "forty" there would be asked to hang up links it
   * does not have. Routing wants the union of the two; everything else wants adjacency.
   *
   * **Earned rather than declared.** The honest source is traffic that actually arrived: a peer
   * whose cursors came in over this medium is one this medium demonstrably carries. A roster the
   * far side asserts would be a claim nobody checked, and a stale or hostile one would narrow every
   * other medium away — which is the failure this whole three-answer scheme exists to stop.
   *
   * Optional, and absent is "cannot say" rather than "nobody" — see `pickRoutes`.
   */
  readonly delivers?: () => ReadonlySet<PeerId>;
  /**
   * How many links this medium sustains at once (RFC-0012 §1, E28) — what {@link admit} spends.
   *
   * Declared by the medium and never configured by the app. It is a property of the radio: a BLE
   * controller degrades every link past roughly six, and an app handed a way to raise that has
   * been handed a way to break the ones it already has. Absent means no limit worth enforcing,
   * which is the honest answer for a relay socket that multiplexes rooms.
   */
  readonly maxLinks?: () => number;
  /**
   * Closes the link to one peer, because the mesh decided this radio is holding more than it
   * sustains (E28). The peer stays discoverable — a drop is a slot reclaimed, not a refusal —
   * and the next advertisement may re-dial it.
   *
   * Present only on a medium that can name its links, which is the same medium that can answer
   * {@link Transport.reaches}. A budget nothing can act on is a number, not a budget.
   */
  readonly drop?: (peer: PeerId) => void;
  /**
   * Resolves when this source has finished its first pass and has nothing more to hand over
   * right now. A transport that cannot tell is settled as soon as it is ready, which is the
   * honest answer for a medium with no end-of-catch-up to report.
   */
  readonly caughtUp?: () => Promise<void>;
  /** Re-requests from the last contiguous position on every open session; the recovery after loss or reconnect. */
  readonly resync?: () => void;
  /**
   * Asks every open session for **state** rather than history (RFC-0019) — what a device with no
   * usable log does on its first session, and what `$recovery.rebuild` does when one is beyond
   * repair. Absent on a medium with no session to ask.
   */
  readonly requestSnapshot?: (interest?: Interest, adoptUnvouched?: boolean) => void;
  /**
   * Everything this medium has already taken in is folded and saved. What `mesh.flush()` awaits
   * before a close: a frame that arrived is folded on a queue, and the save at the end of that
   * queue is the one a process exiting would lose. A medium with no queue declares none.
   */
  readonly flush?: () => Promise<void>;
  /** Asks every connected peer for a grant for this device (flow A step ②). */
  readonly requestGrant?: (invite?: string) => void;
  /** Sends one ephemeral value to every open session; dropped, never queued, on a full link. */
  readonly sendPresence?: (wire: Uint8Array) => void;
  /**
   * Bytes out of band, by hash (D18, D30). Absent is a fact about the medium, not a bug: a raw
   * radio says so rather than pretending, and `mesh.blobs` answers `NoSuchCapability`.
   */
  readonly blobs?: TransportBlobs;
  /**
   * Naming a position in an ordered log and waiting to reach it (RFC-0020 §3.2). Present only on
   * a medium that has one — a relay room does, a peer-to-peer radio does not.
   */
  readonly visibility?: TransportVisibility;
  readonly onStatus?: (cb: (online: boolean) => void) => Unsubscribe;
  /**
   * Link-level endings as they happen (book ch. 18): proved, refused, closed, dropped, failed.
   *
   * `onStatus` answers whether the medium is up, which is a different question and the one that
   * reads `ok` while every link to a peer is being refused. This answers the other: it is where
   * *"why will this device not talk to that one"* has an answer at all.
   *
   * Optional, because a medium that has no notion of a link — a transport a test built out of
   * two functions — has nothing to say here, and saying nothing is a fact about it.
   */
  readonly onLinkEvent?: (cb: (event: LinkEvent) => void) => Unsubscribe;
  /**
   * Which medium this is, for diagnosis (book ch. 16, 18). Two adapters exist per protocol
   * where two protocols exist — AWDL and Wi-Fi Aware never interoperate — so a merged
   * "p2p-wifi" would hide exactly the fact a mixed fleet must know. Absent is `"unknown"`,
   * which is the honest answer for a transport a test built out of two functions.
   */
  readonly kind?: TransportKind;
  /**
   * Why this medium is not carrying, in terms a person can act on (book ch. 18): a UI can say
   * "Bluetooth is off" rather than drawing a red dot. Present only where the platform tells the
   * truth about its radio; absent, {@link Transport.onStatus} is all anyone knows, and a source
   * that is down reads as `temporarily-unavailable`.
   */
  readonly condition?: () => TransportCondition;
}

// the two vocabularies a source is described by, kept where every other reader can take them
// without holding a `Transport` — see `medium.ts`
export type { TransportCondition, TransportKind } from "./medium.js";

export interface FrameTransportOptions {
  readonly name: string;
  /** The medium behind this source, for diagnosis; absent reads as `"unknown"` (book ch. 18). */
  readonly kind?: TransportKind;
  /** What this medium says about itself when it is not carrying; absent leaves `onStatus` the only word. */
  readonly condition?: () => TransportCondition;
  /** A packet or a frame that went nowhere, threaded into the upgrader so it reports too. */
  readonly onDropped?: (why: string) => void;
  /**
   * What this medium says about itself, as {@link Transport.route} — declared here rather than
   * added to the returned object so that a link joining a peer session can be scored by the same
   * profile the mesh scores the transport by. Two copies of that answer is one too many.
   */
  readonly route?: () => RouteProfile;
  /**
   * Discover the medium and `attach` a link per peer found; resolve when discovery is up.
   *
   * Attaching with a peer is what puts the link in that peer's session. Name it as soon as the
   * handshake proves it and not before: a link attached under a peer nobody checked would hand
   * one peer's conversation to another.
   */
  readonly open: (
    ctx: TransportContext,
    attach: (link: FrameLink, peer?: PeerId) => Bridge,
    upgrade: Upgrader,
    /**
     * The cheap rung of the door, asked before a dial is spent (book ch. 14).
     *
     * All it has is what the medium announced, so being wrong costs a link the next sighting
     * re-offers — and being right saves a handshake, a radio slot and a socket against a peer
     * this device was never going to keep. A medium with no door admits everything, which is
     * what every medium did before there was one.
     */
    mayDial: (claimed: PeerId) => Promise<boolean>,
  ) => Promise<void> | void;
  readonly close?: () => Promise<void> | void;
  /** Milliseconds before `whenReady` force-resolves. Default 1000. */
  readonly forceReadyAfter?: number;
}

/** Builds a transport from `open`: the base every framed medium extends. Attached links get the full session bridge. */
export function createFrameTransport(options: FrameTransportOptions): Transport {
  const { name, open, close, forceReadyAfter = 1000 } = options;
  /** Bridges this transport owns: the links whose peer it could not name. */
  const bridges = new Set<Bridge>();
  /** Sessions this transport has joined, and how to leave them. A session it shares, never owns. */
  const joined = new Map<SessionLink, { readonly bridge: Bridge; readonly leave: () => void }>();
  const status = createHub<boolean>();
  const links = createHub<LinkEvent>();
  let ready: Promise<void> = Promise.resolve();

  /** Every bridge this transport speaks through, whether it owns it or shares it. */
  const speaking = (): readonly Bridge[] => [
    ...bridges,
    ...new Set([...joined.values()].map((held) => held.bridge)),
  ];

  return {
    name,
    ...omitUndefined({
      kind: options.kind,
      condition: options.condition,
      route: options.route,
    }),
    start: async (ctx) => {
      // the mesh's clock where there is one, so a link event and the fold beside it agree
      const at = ctx.now ?? (() => Temporal.Now.instant());
      const note = (fact: LinkFact): void => links.emit({ ...fact, transport: name, at: at() });
      const attach = (link: FrameLink, peer?: PeerId): Bridge => {
        const bridgeOptions: BridgeOptions = {
          engine: ctx.engine,
          identity: ctx.identity,
          grants: ctx.grants,
        };
        /**
         * Only once both halves are known. A link whose peer has not been named yet carries
         * everything, because narrowing on an unknown addressee would ask the scorer to choose
         * among links it cannot tell apart — and the frame it declined to send is one nobody
         * sends, which is divergence rather than routing.
         */
        if (ctx.carries !== undefined && peer !== undefined) {
          const carries = ctx.carries;
          Object.assign(bridgeOptions, {
            carries: (message: RouteMessage) => carries(name, { ...message, to: peer }),
          });
        }
        if (ctx.now !== undefined) Object.assign(bridgeOptions, { now: ctx.now });
        if (ctx.onGrantRequest !== undefined)
          Object.assign(bridgeOptions, { onGrantRequest: ctx.onGrantRequest });
        if (ctx.onPresence !== undefined)
          Object.assign(bridgeOptions, { onPresence: ctx.onPresence });
        // the two halves of signed custody: what this device can vouch for, and where a peer's
        // vouch for us lands. Neither is required, and a link with only one of them is coherent
        if (ctx.incarnation !== undefined)
          Object.assign(bridgeOptions, { incarnation: ctx.incarnation });
        if (ctx.onReceipt !== undefined) Object.assign(bridgeOptions, { onReceipt: ctx.onReceipt });
        if (ctx.onSnapshot !== undefined)
          Object.assign(bridgeOptions, { onSnapshot: ctx.onSnapshot });
        if (ctx.certificate !== undefined)
          Object.assign(bridgeOptions, { certificate: ctx.certificate });
        if (ctx.trust !== undefined) Object.assign(bridgeOptions, { trust: ctx.trust });
        // one table, every link: a route learned here is one every other link may advertise
        if (ctx.routes !== undefined) Object.assign(bridgeOptions, { routes: ctx.routes });
        // the same key ring on every link: what a device can read does not depend on the medium
        if (ctx.crypto !== undefined) Object.assign(bridgeOptions, { crypto: ctx.crypto });
        // once per peer, because a session builds its bridge once: subscribing where the bridge
        // is made is what keeps three media reaching one laptop from reporting its errors thrice
        const build = (framed: FrameLink): Bridge => {
          const bridge = bridgeFramedLink(framed, bridgeOptions);
          bridge.onError((error) =>
            note({ kind: "error", ...omitUndefined({ peer }), why: error.message }),
          );
          return bridge;
        };
        if (ctx.sessions === undefined || peer === undefined) {
          const bridge = build(link);
          bridges.add(bridge);
          return bridge;
        }
        // named, so it joins the peer's one conversation; what this transport keeps is its seat
        const member: SessionLink = {
          id: name,
          link,
          ...omitUndefined({ route: options.route }),
        };
        const leave = ctx.sessions.join(peer, member, build);
        const session = ctx.sessions.get(peer);
        if (session === undefined) {
          // unreachable: `join` built it. Falling back to a bridge of our own is the answer that
          // still syncs, rather than the one that throws inside a radio callback
          const bridge = build(link);
          bridges.add(bridge);
          return bridge;
        }
        joined.set(member, { bridge: session.bridge, leave });
        return session.bridge;
      };
      /**
       * Frame boundaries, the handshake, the door and the attach — in one place, so no adapter
       * can hand the bridge a channel it forgot to secure. What a medium supplies is a channel;
       * what makes a channel safe to carry a mesh over is not a fact about the medium.
       */
      const upgrade = reportingUpgrader(
        createUpgrader({
          identity: ctx.identity,
          transport: name,
          attach: (link, peer) => attach(link, peer),
          // one decision per peer is the door's own property, not this transport's: see
          // `oneSeatPerPeer`, which is what the mesh wraps its gate in
          ...omitUndefined({ admits: ctx.admits }),
          onDropped: (why) => {
            note({ kind: "dropped", why });
            options.onDropped?.(why);
          },
        }),
        note,
      );
      /**
       * The cheap rung's refusal is reported too, and it is the one a lobby actually produces:
       * a stranger announcing every two seconds never reaches a handshake, so a `refused` feed
       * without this would be empty in exactly the case somebody is trying to explain. What it
       * names is a claim, which is what the rung has.
       */
      const mayDial = async (claimed: PeerId): Promise<boolean> => {
        const allowed =
          (await ctx.admits?.({ peer: claimed, transport: name, stage: "dial" })) ?? true;
        if (!allowed)
          note({ kind: "refused", peer: claimed, why: "the door refused before a dial was spent" });
        return allowed;
      };
      const opened = Promise.resolve(open(ctx, attach, upgrade, mayDial)).then(() =>
        status.emit(true),
      );
      ready = Promise.race([
        opened,
        new Promise<void>((resolve) => void setTimeout(resolve, forceReadyAfter)),
      ]);
      await opened;
    },
    whenReady: () => ready,
    flush: async () => {
      await Promise.all(speaking().map((bridge) => bridge.flush()));
    },
    resync: () => {
      for (const bridge of speaking()) bridge.resync();
    },
    requestSnapshot: (interest, adoptUnvouched) => {
      for (const bridge of speaking()) bridge.requestSnapshot(interest, adoptUnvouched);
    },
    requestGrant: (invite) => {
      for (const bridge of speaking()) bridge.requestGrant(invite);
    },
    sendPresence: (wire) => {
      for (const bridge of speaking()) bridge.sendPresence(wire);
    },
    stop: async () => {
      for (const bridge of bridges) bridge.close();
      bridges.clear();
      // a session is left, not closed: another medium may still be carrying this peer, and
      // closing the conversation because one of its links stopped is the bug sessions prevent
      for (const held of joined.values()) held.leave();
      joined.clear();
      status.emit(false);
      await close?.();
    },
    onStatus: status.subscribe,
    onLinkEvent: links.subscribe,
  };
}

/** The 20-line transport: one link from `pipe`, bridged. Enough for a relay socket or a loopback end. */
export const linkTransport = (
  name: string,
  pipe: (ctx: TransportContext) => FrameLink | Promise<FrameLink>,
): Transport =>
  createFrameTransport({
    name,
    open: async (ctx, attach) => void attach(await pipe(ctx)),
  });
