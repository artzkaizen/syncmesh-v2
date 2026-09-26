import type { Cursors, Interest, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { createHub, interestFrom, narrows } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame, grantRequestFrame, presenceFrame } from "@syncmesh/transport";

import type { LinkReport } from "./link-report.js";
import type { Redial } from "./redial.js";
import type { SessionHooks } from "./session.js";

import { createBlobChannel } from "./blob-channel.js";
import { RELAY_PROTOCOL_VERSIONS, joinCore, joinFrame, speaksHandshake } from "./frames.js";
import { createLinkReport } from "./link-report.js";
import { proveJoin } from "./proof.js";
import { createRedial } from "./redial.js";
import { isHello, secureLink, type SecureLink } from "./secure.js";
import { wireSession } from "./session.js";

/** Why a socket this file hung up hung up, said once here and read by the close that follows. */
/**
 * How long a peer stays claimed after it was last heard through this relay.
 *
 * Long against the cursor traffic that re-arms it — a device that is moving at all reports its
 * position far more often than this — and short against somebody leaving a building. Erring long
 * would be the worse mistake: a claim outranks a medium that says nothing, so an entry that
 * outlives the peer pulls frames away from the radio that is actually holding them.
 */
const HEARD_TTL_MS = 60_000;

/** The claimed peers, with the ones that have gone quiet dropped on the way past. */
const stillHeard = (heard: Map<PeerId, number>): ReadonlySet<PeerId> => {
  const cutoff = Date.now() - HEARD_TTL_MS;
  for (const [peer, at] of heard) if (at < cutoff) heard.delete(peer);
  return new Set(heard.keys());
};

const MUTE = "the relay stopped answering: no frame within 2.5 times its keepalive";
const REFUSED = "the relay speaks none of the protocol versions this build offers";
const UNSENT = "the frame did not leave the relay socket";
const UNSECURED = "the link is not sealed yet, and nothing but a hello travels before it is";
const UNDIALLED = "the relay could not be dialled";

/** A thrown cause in words, or the sentence that stands in when it brought none. */
const reasonOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/**
 * One dialed connection to a relay: whole frames both ways, a close signal, and a `send`
 * that MUST throw when the frame did not leave (RFC-0005's rule; reconnect recovers).
 */
export interface RelayDial {
  readonly send: (frame: Uint8Array) => void;
  readonly onFrame: (cb: (frame: Uint8Array) => void) => Unsubscribe;
  readonly onClose: (cb: () => void) => Unsubscribe;
  readonly close: () => void;
}

export interface RelayTransportOptions {
  readonly name?: string;
  readonly dial: () => Promise<RelayDial> | RelayDial;
  readonly versions?: readonly number[];
  /** First reconnect delay; doubles per failure up to `maxReconnectMs`. Default 500. */
  readonly reconnectMs?: number;
  readonly maxReconnectMs?: number;
  /** Milliseconds before `whenReady` force-resolves so a dead relay never wedges the mesh. Default 1000. */
  readonly forceReadyAfter?: number;
  /**
   * What this device wants from the room. It narrows: a relay applies it after the read
   * policy, so an interest can make a device see less and never more.
   */
  readonly interest?: Interest;
  /** How near this source is (RFC-0019); a relay sits between local storage and a radio. Default 1. */
  readonly priority?: number;
}

/**
 * One device's link to a relay, its state declared in one place: the live socket, the liveness
 * deadline, the peers heard through it, and the two promises the transport answers with.
 *
 * Private to this module (D29): {@link relayTransport} hands the mesh a literal that delegates
 * here, never this instance, so a wrapper that spreads the transport keeps every member.
 */
class RelayLink {
  readonly name: string;
  readonly status = createHub<boolean>();
  readonly blobChannel = createBlobChannel((frame) => this.sendSafe(frame));
  // the mesh's clock where there is one, so a link event and the fold beside it agree — the same
  // rule `createFrameTransport` follows, and the reason `ctx` is read per call rather than captured
  readonly report: LinkReport;

  private readonly options: RelayTransportOptions;
  private readonly versions: readonly number[];
  private readonly redial: Redial;
  private ctx: TransportContext | undefined;
  private live: RelayDial | undefined;
  private stopped = false;
  private fatal = false;
  /** This join asked from nothing because the interest outgrew what our cursors describe (D23). */
  private repaging = false;
  private online = false;
  /** This session's challenge from the room; a v2 join is sent once it has arrived, never before (D33). */
  private nonce: Uint8Array | undefined;
  /**
   * This session's sealed link (D36), from the room's hello on. Everything this device sends after
   * its own hello goes through it, and everything it hears is opened by it; a join is sent once the
   * session exists, never before. Absent on a room that challenges instead.
   */
  private link: SecureLink | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private keepaliveMs: number | undefined;
  private unsubscribe: Unsubscribe[] = [];
  private readyResolve = (): void => undefined;
  private ready = new Promise<void>((resolve) => (this.readyResolve = resolve));
  /**
   * The deadline a dead relay is allowed to hold the mesh for, armed once per `start`.
   *
   * Held rather than folded into `ready`, because {@link Transport.whenReady} and
   * {@link Transport.caughtUp} are two questions and only one of them is answered by a hello.
   */
  private forced = Promise.resolve();
  private lastPageResolve = (): void => undefined;
  // re-armed on every reconnect: a session that dropped mid-catch-up has not finished its pass,
  // and answering otherwise would let an app draw an empty state over a half-delivered room
  private lastPage = new Promise<void>((resolve) => (this.lastPageResolve = resolve));
  /**
   * Peers whose traffic has come through this relay, and when each was last heard.
   *
   * What `Transport.delivers` answers from. Timed out rather than kept, because a claim that
   * outlives the peer is worse than no claim at all: routing ranks a claim above a medium that
   * says nothing, so a stale entry here would pull frames away from a radio that *is* holding the
   * device. {@link HEARD_TTL_MS} is generous against the cursor traffic that feeds it — a live
   * peer re-arms its entry every time it moves — and short against a person walking out of a
   * building.
   */
  private readonly heard = new Map<PeerId, number>();

  constructor(options: RelayTransportOptions) {
    this.options = options;
    this.name = options.name ?? "relay";
    this.versions = options.versions ?? RELAY_PROTOCOL_VERSIONS;
    this.report = createLinkReport(this.name, () => this.ctx?.now?.() ?? Temporal.Now.instant());
    this.redial = createRedial({
      dial: options.dial,
      done: () => this.stopped || this.fatal,
      onDialed: (dialed) => this.session(dialed),
      // a dial that never opened is not a link that closed: nothing was ever there to end, and this
      // is the one ending a relay that is simply not running ever produces
      onFailed: (cause) => this.report.undialled(reasonOf(cause, UNDIALLED)),
      ...(options.reconnectMs !== undefined && { reconnectMs: options.reconnectMs }),
      ...(options.maxReconnectMs !== undefined && { maxReconnectMs: options.maxReconnectMs }),
    });
  }

  private sendSafe(frame: Uint8Array): void {
    const out = this.link === undefined ? frame : this.link.seal(frame);
    if (out === undefined) {
      // on a sealed link nothing leaves in the clear: what was asked for before the handshake is
      // said to have been dropped, and the join after the handshake re-requests what it covered
      this.report.dropped(UNSECURED);
      return;
    }
    try {
      this.live?.send(out);
    } catch (cause) {
      // the frame did not leave; the reconnect's fresh join re-requests everything it covered
      this.report.dropped(reasonOf(cause, UNSENT));
    }
  }

  /** Ends the session for a reason of ours, so the close that follows can say what it was. */
  private hangUp(why: string): void {
    this.report.closing(why);
    this.live?.close();
  }

  private rearm(): void {
    if (this.keepaliveMs === undefined) return; // a hello-less relay arms nothing
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.hangUp(MUTE), this.keepaliveMs * 2.5);
  }

  /**
   * The position to ask from — ours, unless our cursors describe a slice this device has since
   * widened past (D23).
   *
   * A scoped cursor means *"everything below N that I asked for"*. Widen the interest and the
   * same number silently claims events the old filter dropped and the new one wants, so nothing
   * would ever offer them again. Asking from nothing instead re-pages the run under the new
   * interest, and the events that arrive are folded normally — the engine dedups on what it has
   * stored, not on what its cursor claims, so the repair is complete.
   *
   * Narrowing keeps the cursor, because a cursor true for a wider slice is true for a smaller
   * one. So does an unscoped cursor, whose plain meaning is already the stronger claim.
   */
  private askFrom(context: TransportContext): Cursors {
    const coverage = context.engine.coverage();
    this.repaging = !narrows(this.options.interest, interestFrom(coverage.scope));
    return this.repaging ? new Map() : coverage.synced;
  }

  /**
   * Joins the room. On a sealed link (D36) the join is sent once the handshake is done and proves
   * nothing itself: the hello already proved this key, and the room holds the join to that name.
   * On a challenging room (D33) it signs the challenge, and nothing is sent before that challenge
   * has arrived: a join a room cannot verify is one it refuses, and sending it anyway would only
   * earn a hang-up. A re-join on the same socket — the holdback's `rejoin` — goes the same way
   * over its new cursors.
   */
  join(): void {
    if (this.ctx === undefined) return;
    const { identity, grants } = this.ctx;
    if (this.link !== undefined) {
      if (this.link.session() === undefined) return;
      const cursors = this.askFrom(this.ctx);
      this.sendSafe(joinFrame(this.versions, identity.peerId, cursors, this.options.interest));
    } else {
      if (this.nonce === undefined) return;
      const cursors = this.askFrom(this.ctx);
      const core = joinCore(this.versions, identity.peerId, cursors, this.options.interest);
      this.sendSafe(
        joinFrame(
          this.versions,
          identity.peerId,
          cursors,
          this.options.interest,
          proveJoin(identity, this.nonce, core),
        ),
      );
    }
    for (const wire of grants.allWires()) this.sendSafe(grantFrame(wire));
  }

  /**
   * The relay refused this build's protocol, in one of its two voices: a typed `version` error,
   * or a first frame this build was told not to answer. Permanent — no reconnect loop against it.
   */
  private refused(): void {
    this.report.refused(REFUSED);
    this.fatal = true;
    this.hangUp(REFUSED);
  }

  /**
   * Raw socket bytes to the frames the session reads (D36). The room's first frame says which
   * protocol it speaks: a hello opens a sealed link, and our hello answers it in the clear before
   * anything else; a CBOR frame is a challenging room, whose frames arrive as they are.
   */
  private inbound(raw: Uint8Array, deliver: (frame: Uint8Array) => void): void {
    if (this.ctx === undefined) return;
    if (this.link === undefined) {
      if (!isHello(raw)) {
        deliver(raw);
        return;
      }
      if (!speaksHandshake(this.versions)) {
        this.refused();
        return;
      }
      const link = secureLink(this.ctx.identity);
      const opened = link.receive(raw);
      if (opened.isErr()) {
        this.hangUp(opened.error.message);
        return;
      }
      this.link = link;
      // our hello answers the room's, in the clear; it is the last thing that travels so
      if (link.hello !== undefined) {
        try {
          this.live?.send(link.hello);
        } catch (cause) {
          this.report.dropped(reasonOf(cause, UNSENT));
          return;
        }
      }
      this.join();
      return;
    }
    const opened = this.link.receive(raw);
    if (opened.isErr()) {
      this.hangUp(opened.error.message);
      return;
    }
    if (opened.value !== undefined) deliver(opened.value);
  }

  /** The dial as the session sees it: frames already opened, hellos already answered. */
  private plain(dialed: RelayDial): RelayDial {
    return {
      send: dialed.send,
      onFrame: (cb) => dialed.onFrame((raw) => this.inbound(raw, cb)),
      onClose: dialed.onClose,
      close: dialed.close,
    };
  }

  /**
   * Peers still claimed, with the ones that have gone quiet dropped on the way past.
   *
   * **Nothing is claimed while this source is down**, and that guard is load-bearing now rather
   * than tidy. A claim ranks above a medium that merely says nothing, so a relay that went on
   * claiming a room it could no longer reach would *take* frames from the radio sitting next to the
   * device — the exact failure this whole scheme was built to stop, reintroduced by the fix for it.
   *
   * What remains is the window where this socket is dead and nothing has noticed: a relay's silent
   * death is only detected at 2.5× the keepalive it announced, and until then `online` is still
   * true. That floor belongs to the relay protocol rather than to routing, and it is the honest
   * limit of what this can promise.
   *
   * `stopped` as well as `online`, because a transport taken out of the mesh keeps whatever it last
   * believed: `online` only turns over when a socket *closes*, and a stopped source never gets one.
   *
   * Deliberately **not** `reaches`: this medium holds one link, and `churn` counts `reaches`
   * against `maxLinks` before hanging something up. A relay answering "forty" there would be
   * asked to close links it never had. See `Transport.delivers`.
   */
  delivers(): ReadonlySet<PeerId> {
    return this.online && !this.stopped ? stillHeard(this.heard) : new Set();
  }

  private session(dialed: RelayDial): void {
    if (this.ctx === undefined) return;
    this.live = dialed;
    this.keepaliveMs = undefined;
    this.nonce = undefined;
    this.link = undefined;
    const hooks: SessionHooks = {
      sendSafe: (frame) => this.sendSafe(frame),
      rearm: () => this.rearm(),
      rejoin: () => this.join(),
      onChallenge: (nonce) => {
        // a challenge is a v2 room; a build offering only the sealed link has nothing to sign it with
        if (!this.versions.includes(2)) {
          this.refused();
          return;
        }
        this.nonce = nonce;
        this.join();
      },
      onHello: (announcedMs) => {
        this.report.proven();
        this.keepaliveMs = announcedMs;
        this.rearm();
        this.redial.settled();
        this.online = true;
        this.status.emit(true);
        this.readyResolve();
      },
      onVersionRefused: () => {
        this.report.refused(REFUSED);
        this.fatal = true;
      },
      onDropped: this.report.dropped,
      onBlobAnswer: this.blobChannel.answer,
      onPeerHeard: (peer) => void this.heard.set(peer, Date.now()),
      onCaughtUp: () => {
        this.repaging = false;
        this.lastPageResolve();
      },
    };
    // what a scoped coverage on the last page has to match before this device adopts it
    if (this.options.interest !== undefined)
      Object.assign(hooks, { interest: this.options.interest });
    Object.assign(hooks, { repaging: () => this.repaging });
    const offs = wireSession(this.ctx, this.plain(dialed), hooks);
    const offClose = dialed.onClose(() => {
      this.report.closed();
      clearTimeout(this.deadline);
      for (const off of this.unsubscribe) off();
      this.unsubscribe = [];
      this.live = undefined;
      if (this.online) {
        this.online = false;
        this.status.emit(false);
      }
      if (this.stopped || this.fatal) return;
      this.lastPage = new Promise<void>((resolve) => (this.lastPageResolve = resolve));
      this.redial.again();
    });
    this.unsubscribe = [...offs, offClose];
    // no join here: the room speaks first, and its hello or its challenge is what gets answered
  }

  /**
   * Drop whatever we are holding and dial again immediately.
   *
   * Called when something outside knows the network moved — see `Transport.wake`. Hanging up
   * first matters: after a Wi-Fi drop the old socket is usually *not* closed, merely orphaned, so
   * dialling without ending it would leave two sessions and let the stale one keep claiming the
   * keepalive deadline. `settled()` resets the backoff, because a network that just came back
   * should not be made to wait out a delay earned while it was gone.
   */
  wake(): void {
    if (this.stopped || this.fatal) return;
    this.redial.cancel();
    this.redial.settled();
    if (this.live === undefined) this.redial.attempt();
    else this.hangUp("the network changed, so this link is being re-established");
  }

  sendPresence(wire: Uint8Array): void {
    this.sendSafe(presenceFrame(wire));
  }

  requestGrant(invite?: string): void {
    if (this.ctx !== undefined) this.sendSafe(grantRequestFrame(this.ctx.identity.peerId, invite));
  }

  start(context: TransportContext): Promise<void> {
    this.ctx = context;
    this.stopped = false;
    this.ready = new Promise<void>((resolve) => (this.readyResolve = resolve));
    this.forced = new Promise<void>((resolve) =>
      setTimeout(resolve, this.options.forceReadyAfter ?? 1000),
    );
    this.ready = Promise.race([this.ready, this.forced]);
    this.redial.attempt();
    return Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * The last page, or the deadline — **not** the hello.
   *
   * This used to race the catch-up against `ready`, and `ready` resolves the moment the relay
   * says hello. A hello is the *start* of a first pass, so the answer came back before a single
   * page had landed and `mesh.settled()` meant "the socket opened". Measured: a second install
   * joining a seeded room read its own empty database, decided the workspace needed seeding and
   * authored a duplicate of it — which converged, because that seed is deterministic, and left
   * a log with two authors for every row.
   *
   * The deadline is still there and still does the job it was put there for: a relay that never
   * speaks force-resolves at `forceReadyAfter`, so a source that cannot answer is never the one
   * that wedges the mesh. What it no longer does is answer on behalf of one that is mid-sentence.
   */
  caughtUp(): Promise<void> {
    return Promise.race([this.lastPage, this.forced]);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.redial.cancel();
    clearTimeout(this.deadline);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.live?.close();
    this.live = undefined;
    return Promise.resolve();
  }
}

/**
 * The client half of the relay protocol: join with our contiguous cursors, apply pages in order,
 * push what the relay lacks only after the last page, hold a liveness deadline of 2.5× the
 * relay's keepalive re-armed on every frame (a hello-less relay arms nothing), and reconnect
 * with backoff. A version refusal is permanent — no reconnect loop against a relay that
 * already said no.
 */
export function relayTransport(options: RelayTransportOptions): Transport {
  const link = new RelayLink(options);
  return {
    name: link.name,
    kind: "websocket",
    delivers: () => link.delivers(),
    wake: () => link.wake(),
    condition: link.report.condition,
    onLinkEvent: link.report.onLinkEvent,
    priority: options.priority ?? 1,
    sendPresence: (wire) => link.sendPresence(wire),
    blobs: link.blobChannel.capability,
    start: (context) => link.start(context),
    whenReady: () => link.whenReady(),
    caughtUp: () => link.caughtUp(),
    resync: () => link.join(),
    requestGrant: (invite) => link.requestGrant(invite),
    onStatus: link.status.subscribe,
    stop: () => link.stop(),
  };
}
