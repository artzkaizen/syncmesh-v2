import type { Cursors, Unsubscribe } from "@syncmesh/engine";
import type { StoredEvent } from "@syncmesh/engine";
import type { Transport, TransportContext } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import {
  createHoldback,
  cursorsFrame,
  eventFrame,
  grantFrame,
  grantRequestFrame,
  presenceFrame,
} from "@syncmesh/transport";
import { decodeAndVerify, encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";

import { RELAY_PROTOCOL_VERSIONS, decodeRelayFrame, joinFrame } from "./frames.js";

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
}

const envelopeOf = (entry: StoredEvent, ctx: TransportContext): Uint8Array | undefined => {
  if (entry.event.peerId === ctx.identity.peerId) return signEvent(entry.event, ctx.identity).wire;
  if (entry.sig !== undefined) return encodeCbor([encodeEventCore(entry.event), entry.sig]);
  return undefined;
};

/**
 * The client half of E12: join with our contiguous cursors, apply pages strictly in order,
 * push what the relay lacks only after the last page, hold a liveness deadline of 2.5× the
 * relay's keepalive re-armed on every frame (a hello-less relay arms nothing), and reconnect
 * with backoff. A version refusal is permanent — no reconnect loop against a relay that
 * already said no.
 */
/** What one wired session may ask of the transport shell around it. */
interface SessionHooks {
  readonly sendSafe: (frame: Uint8Array) => void;
  /** Any frame re-arms the liveness deadline. */
  readonly rearm: () => void;
  /** Holdback overflow: a fresh join re-pages from our contiguous position. */
  readonly rejoin: () => void;
  readonly onHello: (keepaliveMs: number) => void;
  /** The relay's typed version refusal is permanent — no reconnect loop against it. */
  readonly onVersionRefused: () => void;
}

/** Everything one session subscribes to; the returned unsubscribes are the session's teardown. */
function wireSession(
  context: TransportContext,
  dialed: RelayDial,
  hooks: SessionHooks,
): readonly Unsubscribe[] {
  const { engine, identity, grants } = context;
  const now = context.now ?? (() => Temporal.Now.instant());
  const holdback = createHoldback(engine, identity.peerId, 512);
  let chain: Promise<unknown> = Promise.resolve();
  let caughtUp = false;
  let relayCursors: Cursors = new Map();

  const fold = (wires: readonly Uint8Array[]): void => {
    chain = chain.then(async () => {
      const authors = new Set<StoredEvent["event"]["peerId"]>();
      for (const wire of wires) {
        const verified = decodeAndVerify(wire);
        if (verified.isErr()) continue; // junk from a relay is dropped, never folded
        if (holdback.put(verified.value)) {
          hooks.rejoin();
          return;
        }
        authors.add(verified.value.event.peerId);
      }
      for (const author of authors) {
        const batch = holdback.drain(author);
        if (batch.length > 0) await engine.receiveBatch(batch);
      }
    });
  };

  const pushOutstanding = (): void => {
    chain = chain.then(async () => {
      const entries = await engine.eventsSince(relayCursors);
      if (entries.isErr()) return;
      for (const entry of entries.value) {
        const wire = envelopeOf(entry, context);
        if (wire !== undefined) hooks.sendSafe(eventFrame(wire));
      }
    });
  };

  /** Our contiguous position, for every other peer's `delivered`; the relay passes it on. */
  const sendCursors = (): void =>
    hooks.sendSafe(cursorsFrame(identity.peerId, engine.coverage().synced));

  const onSession = (frame: Extract<RelayFrame, { kind: "session" }>["frame"]): void => {
    if (frame.kind === "presence") context.onPresence?.(frame.wire);
    else if (frame.kind === "grant") void grants.register(frame.wire);
    else if (frame.kind === "cursors") engine.acknowledge(frame.from, frame.cursors, now());
    else if (frame.kind === "grant-request") {
      const request = { peerId: frame.peerId };
      if (frame.invite !== undefined) Object.assign(request, { invite: frame.invite });
      context.onGrantRequest?.(request);
    } else if (frame.kind === "event") fold([frame.wire]);
  };

  const offFrame = dialed.onFrame((bytes) => {
    hooks.rearm();
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isErr()) return;
    const frame = decoded.value;
    if (frame.kind === "hello") {
      relayCursors = frame.cursors;
      hooks.onHello(frame.keepaliveMs);
    } else if (frame.kind === "page") {
      for (const wire of frame.grants) void grants.register(wire);
      fold(frame.events);
      if (!frame.more) {
        caughtUp = true;
        pushOutstanding();
      }
    } else if (frame.kind === "relayed") fold([frame.wire]);
    else if (frame.kind === "error") {
      if (frame.code === "version") hooks.onVersionRefused();
      dialed.close();
    } else if (frame.kind === "session") onSession(frame.frame);
    // ka and unknown: the rearm above was the whole point
  });

  const offOutbound = engine.onOutbound((event) => {
    // pre-catch-up writes are already in the store; the push after the last page covers them
    if (caughtUp) hooks.sendSafe(eventFrame(signEvent(event, identity).wire));
  });
  const offRegistered = grants.onRegistered((_grant, wire) => hooks.sendSafe(grantFrame(wire)));
  // a fold of peers' events moved our position: say so once caught up, so their `delivered` settles
  const offFolds = engine.onFoldBatch((batch) => {
    if (caughtUp && batch.source === "remote") sendCursors();
  });
  return [offFrame, offOutbound, offRegistered, offFolds];
}

export function relayTransport(options: RelayTransportOptions): Transport {
  const name = options.name ?? "relay";
  const versions = options.versions ?? RELAY_PROTOCOL_VERSIONS;
  const baseMs = options.reconnectMs ?? 500;
  const maxMs = options.maxReconnectMs ?? 30_000;
  const status = createHub<boolean>();

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
    sendSafe(joinFrame(versions, ctx.identity.peerId, ctx.engine.coverage().synced));
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
