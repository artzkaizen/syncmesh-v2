import type { Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { createHub, interestText } from "@syncmesh/engine";
import { omitUndefined } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame, grantRequestFrame, presenceFrame } from "@syncmesh/transport";

import type { LinkReport } from "./link-report.js";
import type { Redial } from "./redial.js";
import type { JoinedScope } from "./scoped.js";
import type { SessionHooks } from "./session.js";
import type { RelayDial, RelayTransportOptions } from "./transport.js";

import { createBlobChannel } from "./blob-channel.js";
import { RELAY_PROTOCOL_VERSIONS, joinCore, joinFrame } from "./frames.js";
import { createHeard } from "./heard.js";
import { createLinkReady } from "./link-ready.js";
import { createLinkReport } from "./link-report.js";
import { createLinkSeal, type LinkSeal } from "./link-seal.js";
import { createLiveness } from "./liveness.js";
import { proveJoin } from "./proof.js";
import { createRedial } from "./redial.js";
import { entitledScope, joinPosition } from "./scoped.js";
import { wireSession } from "./session.js";
import { createVisibility } from "./visibility.js";

/** Why a socket this file hung up hung up, said once here and read by the close that follows. */
const MUTE = "the relay stopped answering: no frame within 2.5 times its keepalive";
const REFUSED = "the relay speaks none of the protocol versions this build offers";
const UNSENT = "the frame did not leave the relay socket";
const UNSECURED = "the link is not sealed yet, and nothing but a hello travels before it is";
const UNDIALLED = "the relay could not be dialled";
const REENTITLED =
  "the relay admits this device under a different entitlement, so it re-pages from nothing";

/** A thrown cause in words, or the sentence that stands in when it brought none. */
const causeText = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/**
 * One device's link to a relay, its state declared in one place: the live socket, the liveness
 * deadline, the peers heard through it, and the two promises the transport answers with.
 *
 * Private to this package (D29): {@link relayTransport} hands the mesh a literal that delegates
 * here, never this instance, so a wrapper that spreads the transport keeps every member.
 */
export class RelayLink {
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
  /** What the last join on this session may be served (D23, D40). */
  private joined: JoinedScope = { sent: undefined, entitled: undefined };
  /**
   * The room admits this device under a different entitlement than its cursors were earned under
   * (D24), so the next join asks from nothing — held until a catch-up has completed, so a socket
   * lost mid-repair repairs again rather than resuming from the cursors that needed it.
   */
  private reentitled = false;
  /** Where this device has been told the room's log runs, and in which lineage (RFC-0020 §3.2). */
  readonly visibility = createVisibility();
  private online = false;
  /**
   * This session's sealing: the sealed link (D36) from the room's hello on, or the room's challenge
   * (D33) when it challenges instead. A join is sent once either has arrived, never before.
   */
  private readonly sealing: LinkSeal;
  private readonly liveness = createLiveness(() => this.hangUp(MUTE));
  private unsubscribe: Unsubscribe[] = [];
  /** Whether the relay has said hello, and whether a catch-up has reached its last page. */
  private readonly readiness = createLinkReady();
  /** Peers whose traffic has come through this relay: what `Transport.delivers` answers from. */
  private readonly heard = createHeard();

  constructor(options: RelayTransportOptions) {
    this.options = options;
    this.name = options.name ?? "relay";
    this.versions = options.versions ?? RELAY_PROTOCOL_VERSIONS;
    this.report = createLinkReport(this.name, () => this.ctx?.now?.() ?? Temporal.Now.instant());
    this.redial = createRedial(
      omitUndefined({
        dial: options.dial,
        done: () => this.stopped || this.fatal,
        onDialed: (dialed: RelayDial) => this.session(dialed),
        // a dial that never opened is not a link that closed: nothing was ever there to end, and this
        // is the one ending a relay that is simply not running ever produces
        onFailed: (cause: unknown) => this.report.undialled(causeText(cause, UNDIALLED)),
        reconnectMs: options.reconnectMs,
        maxReconnectMs: options.maxReconnectMs,
      }),
    );
    this.sealing = createLinkSeal({
      versions: this.versions,
      relayKey: options.relayKey,
      hooks: {
        refused: (why) => this.refused(why),
        hangUp: (why) => this.hangUp(why),
        sendHello: (hello) => this.sendRaw(hello),
        join: () => this.join(),
      },
    });
  }

  private sendSafe(frame: Uint8Array): void {
    const out = this.sealing.seal(frame);
    if (out === undefined) {
      // on a sealed link nothing leaves in the clear: what was asked for before the handshake is
      // said to have been dropped, and the join after the handshake re-requests what it covered
      this.report.dropped(UNSECURED);
      return;
    }
    this.sendRaw(out);
  }

  /** Bytes onto the socket as they are; `false` when they did not leave. */
  private sendRaw(out: Uint8Array): boolean {
    try {
      this.live?.send(out);
      return true;
    } catch (cause) {
      // the frame did not leave; the reconnect's fresh join re-requests everything it covered
      this.report.dropped(causeText(cause, UNSENT));
      return false;
    }
  }

  /** Ends the session for a reason of ours, so the close that follows can say what it was. */
  private hangUp(why: string): void {
    this.report.closing(why);
    this.live?.close();
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
    const joinable = this.sealing.joinable();
    if (joinable === undefined) return;
    const { nonce } = joinable;
    const { identity, grants } = this.ctx;
    const wanted = this.options.interest;
    const { cursors, repaging } = joinPosition(this.ctx, wanted, this.reentitled);
    this.repaging = repaging;
    this.joined = { sent: wanted, entitled: entitledScope(this.ctx, this.options.interest) };
    const proof =
      nonce === undefined
        ? undefined
        : proveJoin(identity, nonce, joinCore(this.versions, identity.peerId, cursors, wanted));
    this.sendSafe(joinFrame(this.versions, identity.peerId, cursors, wanted, proof));
    for (const wire of grants.allWires()) this.sendSafe(grantFrame(wire));
  }

  /**
   * The relay refused this build's protocol, in one of its voices: a typed `version` error, a
   * first frame this build was told not to answer, or a hello from a key this device was told not
   * to trust. Permanent — no reconnect loop against it.
   */
  private refused(why = REFUSED): void {
    this.report.refused(why);
    this.fatal = true;
    this.hangUp(why);
  }

  /** The dial as the session sees it: frames already opened, hellos already answered. */
  private plain(dialed: RelayDial): RelayDial {
    return {
      send: dialed.send,
      onFrame: (cb) =>
        dialed.onFrame((raw) => {
          if (this.ctx !== undefined) this.sealing.open(this.ctx.identity, raw, cb);
        }),
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
    return this.online && !this.stopped ? this.heard.current() : new Set();
  }

  private session(dialed: RelayDial): void {
    if (this.ctx === undefined) return;
    this.live = dialed;
    this.liveness.forget();
    this.sealing.reset();
    const hooks: SessionHooks = {
      sendSafe: (frame) => this.sendSafe(frame),
      rearm: this.liveness.rearm,
      rejoin: () => this.join(),
      joined: () => this.joined,
      regranted: () =>
        this.ctx !== undefined &&
        interestText(entitledScope(this.ctx, this.options.interest)) !==
          interestText(this.joined.entitled),
      onChallenge: (nonce) => {
        // a challenge is a v2 room; a build offering only the sealed link has nothing to sign it with
        if (!this.versions.includes(2)) {
          this.refused();
          return;
        }
        this.sealing.challenged(nonce);
        this.join();
      },
      onHello: (announcedMs, epoch) => {
        this.visibility.lineage(epoch);
        this.report.proven();
        this.liveness.announce(Temporal.Duration.from({ milliseconds: announcedMs }));
        this.redial.settled();
        this.online = true;
        this.status.emit(true);
        this.readiness.hello();
      },
      onVersionRefused: () => {
        this.report.refused(REFUSED);
        this.fatal = true;
      },
      onDropped: this.report.dropped,
      onBlobAnswer: this.blobChannel.answer,
      onBlobSettled: this.blobChannel.settle,
      onPeerHeard: this.heard.note,
      onCaughtUp: () => {
        this.repaging = false;
        this.reentitled = false;
        this.readiness.lastPage();
      },
      onPosition: (offset) => this.visibility.reached(offset),
      onReentitled: () => {
        this.reentitled = true;
        this.hangUp(REENTITLED);
      },
    };
    // what a scoped coverage on the last page has to match before this device adopts it
    Object.assign(hooks, { repaging: () => this.repaging });
    const offs = wireSession(this.ctx, this.plain(dialed), hooks);
    const offClose = dialed.onClose(() => {
      this.report.closed();
      this.liveness.clear();
      for (const off of this.unsubscribe) off();
      this.unsubscribe = [];
      this.live = undefined;
      if (this.online) {
        this.online = false;
        this.status.emit(false);
      }
      if (this.stopped || this.fatal) return;
      this.readiness.rearmLastPage();
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
    this.readiness.arm(
      Temporal.Duration.from({ milliseconds: this.options.forceReadyAfter ?? 1000 }),
    );
    this.redial.attempt();
    return Promise.resolve();
  }

  whenReady(): Promise<void> {
    return this.readiness.whenReady();
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
    return this.readiness.caughtUp();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.redial.cancel();
    this.liveness.clear();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.live?.close();
    this.live = undefined;
    return Promise.resolve();
  }
}
