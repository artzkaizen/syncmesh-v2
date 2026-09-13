import type { Cursors, Interest, Unsubscribe } from "@syncmesh/engine";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { createHub, interestFrom, narrows } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { grantFrame, grantRequestFrame, presenceFrame } from "@syncmesh/transport";

import type { SessionHooks } from "./session.js";

import { createBlobChannel } from "./blob-channel.js";
import { RELAY_PROTOCOL_VERSIONS, joinFrame } from "./frames.js";
import { createLinkReport } from "./link-report.js";
import { createRedial } from "./redial.js";
import { wireSession } from "./session.js";

/** Why a socket this file hung up hung up, said once here and read by the close that follows. */
const MUTE = "the relay stopped answering: no frame within 2.5 times its keepalive";
const REFUSED = "the relay speaks none of the protocol versions this build offers";
const UNSENT = "the frame did not leave the relay socket";
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
 * The client half of the relay protocol: join with our contiguous cursors, apply pages in order,
 * push what the relay lacks only after the last page, hold a liveness deadline of 2.5× the
 * relay's keepalive re-armed on every frame (a hello-less relay arms nothing), and reconnect
 * with backoff. A version refusal is permanent — no reconnect loop against a relay that
 * already said no.
 */
export function relayTransport(options: RelayTransportOptions): Transport {
  const name = options.name ?? "relay";
  const versions = options.versions ?? RELAY_PROTOCOL_VERSIONS;
  const status = createHub<boolean>();
  const blobs = createBlobChannel((frame) => sendSafe(frame));
  // the mesh's clock where there is one, so a link event and the fold beside it agree — the same
  // rule `createFrameTransport` follows, and the reason `ctx` is read per call rather than captured
  const report = createLinkReport(name, () => ctx?.now?.() ?? Temporal.Now.instant());

  let ctx: TransportContext | undefined;
  let live: RelayDial | undefined;
  let stopped = false;
  let fatal = false;
  /** This join asked from nothing because the interest outgrew what our cursors describe (D23). */
  let repaging = false;
  let online = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let keepaliveMs: number | undefined;
  let unsubscribe: Unsubscribe[] = [];
  let readyResolve = (): void => undefined;
  let ready = new Promise<void>((resolve) => (readyResolve = resolve));
  /**
   * The deadline a dead relay is allowed to hold the mesh for, armed once per `start`.
   *
   * Held rather than folded into `ready`, because {@link Transport.whenReady} and
   * {@link Transport.caughtUp} are two questions and only one of them is answered by a hello.
   */
  let forced = Promise.resolve();
  let caughtUpResolve = (): void => undefined;
  // re-armed on every reconnect: a session that dropped mid-catch-up has not finished its pass,
  // and answering otherwise would let an app draw an empty state over a half-delivered room
  let caughtUp = new Promise<void>((resolve) => (caughtUpResolve = resolve));

  const sendSafe = (frame: Uint8Array): void => {
    try {
      live?.send(frame);
    } catch (cause) {
      // the frame did not leave; the reconnect's fresh join re-requests everything it covered
      report.dropped(reasonOf(cause, UNSENT));
    }
  };

  /** Ends the session for a reason of ours, so the close that follows can say what it was. */
  const hangUp = (why: string): void => {
    report.closing(why);
    live?.close();
  };

  const redial = createRedial({
    dial: options.dial,
    done: () => stopped || fatal,
    onDialed: (dialed) => session(dialed),
    // a dial that never opened is not a link that closed: nothing was ever there to end, and this
    // is the one ending a relay that is simply not running ever produces
    onFailed: (cause) => report.undialled(reasonOf(cause, UNDIALLED)),
    ...(options.reconnectMs !== undefined && { reconnectMs: options.reconnectMs }),
    ...(options.maxReconnectMs !== undefined && { maxReconnectMs: options.maxReconnectMs }),
  });

  const rearm = (): void => {
    if (keepaliveMs === undefined) return; // a hello-less relay arms nothing
    clearTimeout(deadline);
    deadline = setTimeout(() => hangUp(MUTE), keepaliveMs * 2.5);
  };

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
  const askFrom = (context: TransportContext): Cursors => {
    const coverage = context.engine.coverage();
    repaging = !narrows(options.interest, interestFrom(coverage.scope));
    return repaging ? new Map() : coverage.synced;
  };

  const join = (): void => {
    if (ctx === undefined) return;
    sendSafe(joinFrame(versions, ctx.identity.peerId, askFrom(ctx), options.interest));
    for (const wire of ctx.grants.allWires()) sendSafe(grantFrame(wire));
  };

  const session = (dialed: RelayDial): void => {
    if (ctx === undefined) return;
    live = dialed;
    keepaliveMs = undefined;
    const hooks: SessionHooks = {
      sendSafe,
      rearm,
      rejoin: join,
      onHello: (announcedMs) => {
        report.proven();
        keepaliveMs = announcedMs;
        rearm();
        redial.settled();
        online = true;
        status.emit(true);
        readyResolve();
      },
      onVersionRefused: () => {
        report.refused(REFUSED);
        fatal = true;
      },
      onDropped: report.dropped,
      onBlobAnswer: blobs.answer,
      onCaughtUp: () => {
        repaging = false;
        caughtUpResolve();
      },
    };
    // what a scoped coverage on the last page has to match before this device adopts it
    if (options.interest !== undefined) Object.assign(hooks, { interest: options.interest });
    Object.assign(hooks, { repaging: () => repaging });
    const offs = wireSession(ctx, dialed, hooks);
    const offClose = dialed.onClose(() => {
      report.closed();
      clearTimeout(deadline);
      for (const off of unsubscribe) off();
      unsubscribe = [];
      live = undefined;
      if (online) {
        online = false;
        status.emit(false);
      }
      if (stopped || fatal) return;
      caughtUp = new Promise<void>((resolve) => (caughtUpResolve = resolve));
      redial.again();
    });
    unsubscribe = [...offs, offClose];
    join();
  };

  return {
    name,
    kind: "websocket",
    condition: report.condition,
    onLinkEvent: report.onLinkEvent,
    priority: options.priority ?? 1,
    sendPresence: (wire) => sendSafe(presenceFrame(wire)),
    putBlob: blobs.put,
    fetchBlob: blobs.fetch,
    start: (context) => {
      ctx = context;
      stopped = false;
      ready = new Promise<void>((resolve) => (readyResolve = resolve));
      forced = new Promise<void>((resolve) => setTimeout(resolve, options.forceReadyAfter ?? 1000));
      ready = Promise.race([ready, forced]);
      redial.attempt();
      return Promise.resolve();
    },
    whenReady: () => ready,
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
    caughtUp: () => Promise.race([caughtUp, forced]),
    resync: () => join(),
    requestGrant: (invite) => {
      if (ctx !== undefined) sendSafe(grantRequestFrame(ctx.identity.peerId, invite));
    },
    onStatus: status.subscribe,
    stop: () => {
      stopped = true;
      redial.cancel();
      clearTimeout(deadline);
      for (const off of unsubscribe) off();
      unsubscribe = [];
      live?.close();
      live = undefined;
      return Promise.resolve();
    },
  };
}
