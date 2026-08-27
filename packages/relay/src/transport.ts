import type { Interest, Unsubscribe } from "@syncmesh/engine";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { grantFrame, grantRequestFrame, presenceFrame } from "@syncmesh/transport";

import type { SessionHooks } from "./session.js";

import { createBlobChannel } from "./blob-channel.js";
import { RELAY_PROTOCOL_VERSIONS, joinFrame } from "./frames.js";
import { wireSession } from "./session.js";

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
   * What this device wants from the room (E13). It narrows: a relay applies it after the read
   * policy, so an interest can make a device see less and never more.
   */
  readonly interest?: Interest;
}

/**
 * The client half of E12: join with our contiguous cursors, apply pages strictly in order,
 * push what the relay lacks only after the last page, hold a liveness deadline of 2.5× the
 * relay's keepalive re-armed on every frame (a hello-less relay arms nothing), and reconnect
 * with backoff. A version refusal is permanent — no reconnect loop against a relay that
 * already said no.
 */
export function relayTransport(options: RelayTransportOptions): Transport {
  const name = options.name ?? "relay";
  const versions = options.versions ?? RELAY_PROTOCOL_VERSIONS;
  const baseMs = options.reconnectMs ?? 500;
  const maxMs = options.maxReconnectMs ?? 30_000;
  const status = createHub<boolean>();
  const blobs = createBlobChannel((frame) => sendSafe(frame));

  let ctx: TransportContext | undefined;
  let live: RelayDial | undefined;
  let stopped = false;
  let fatal = false;
  let online = false;
  let backoff = baseMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let keepaliveMs: number | undefined;
  let unsubscribe: Unsubscribe[] = [];
  let readyResolve = (): void => undefined;
  let ready = new Promise<void>((resolve) => (readyResolve = resolve));

  const sendSafe = (frame: Uint8Array): void => {
    try {
      live?.send(frame);
    } catch {
      // the frame did not leave; the reconnect's fresh join re-requests everything it covered
    }
  };

  const rearm = (): void => {
    if (keepaliveMs === undefined) return; // a hello-less relay arms nothing
    clearTimeout(deadline);
    deadline = setTimeout(() => live?.close(), keepaliveMs * 2.5);
  };

  const join = (): void => {
    if (ctx === undefined) return;
    sendSafe(
      joinFrame(versions, ctx.identity.peerId, ctx.engine.coverage().synced, options.interest),
    );
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
        keepaliveMs = announcedMs;
        rearm();
        backoff = baseMs;
        online = true;
        status.emit(true);
        readyResolve();
      },
      onVersionRefused: () => {
        fatal = true;
      },
      onBlobAnswer: blobs.answer,
    };
    const offs = wireSession(ctx, dialed, hooks);
    const offClose = dialed.onClose(() => {
      clearTimeout(deadline);
      for (const off of unsubscribe) off();
      unsubscribe = [];
      live = undefined;
      if (online) {
        online = false;
        status.emit(false);
      }
      if (stopped || fatal) return;
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, maxMs);
    });
    unsubscribe = [...offs, offClose];
    join();
  };

  const connect = (): void => {
    if (stopped || fatal) return;
    Promise.resolve()
      .then(() => options.dial())
      .then((dialed) => {
        if (stopped) {
          dialed.close();
          return;
        }
        session(dialed);
      })
      .catch(() => {
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, maxMs);
      });
  };

  return {
    name,
    sendPresence: (wire) => sendSafe(presenceFrame(wire)),
    putBlob: blobs.put,
    fetchBlob: blobs.fetch,
    start: (context) => {
      ctx = context;
      stopped = false;
      ready = new Promise<void>((resolve) => (readyResolve = resolve));
      const forced = new Promise<void>((resolve) =>
        setTimeout(resolve, options.forceReadyAfter ?? 1000),
      );
      ready = Promise.race([ready, forced]);
      connect();
      return Promise.resolve();
    },
    whenReady: () => ready,
    resync: () => join(),
    requestGrant: (invite) => {
      if (ctx !== undefined) sendSafe(grantRequestFrame(ctx.identity.peerId, invite));
    },
    onStatus: status.subscribe,
    stop: () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(deadline);
      for (const off of unsubscribe) off();
      unsubscribe = [];
      live?.close();
      live = undefined;
      return Promise.resolve();
    },
  };
}
