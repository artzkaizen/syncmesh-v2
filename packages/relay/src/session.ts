import type { Cursors, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import { Temporal } from "@syncmesh/temporal";
import { createHoldback, cursorsFrame, eventFrame, grantFrame } from "@syncmesh/transport";
import { decodeAndVerify, encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { RelayDial } from "./transport.js";

import { decodeRelayFrame } from "./frames.js";

/** A stored event as bytes to send: this device signs its own, and relays another's verbatim. */
const envelopeOf = (entry: StoredEvent, ctx: TransportContext): Uint8Array | undefined => {
  if (entry.event.peerId === ctx.identity.peerId) return signEvent(entry.event, ctx.identity).wire;
  if (entry.sig !== undefined) return encodeCbor([encodeEventCore(entry.event), entry.sig]);
  return undefined;
};

/** What one wired session may ask of the transport shell around it. */
export interface SessionHooks {
  readonly sendSafe: (frame: Uint8Array) => void;
  /** Any frame re-arms the liveness deadline. */
  readonly rearm: () => void;
  /** Holdback overflow: a fresh join re-pages from our contiguous position. */
  readonly rejoin: () => void;
  readonly onHello: (keepaliveMs: number) => void;
  /** The relay's typed version refusal is permanent — no reconnect loop against it. */
  readonly onVersionRefused: () => void;
  /** The relay answered a fetch: the bytes, or `undefined` when it holds none under that hash. */
  readonly onBlobAnswer: (hash: string, bytes: Uint8Array | undefined) => void;
}

/** Everything one session subscribes to; the returned unsubscribes are the session's teardown. */
export function wireSession(
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
    } else if (frame.kind === "blob") hooks.onBlobAnswer(frame.hash, frame.bytes);
    else if (frame.kind === "blob-missing") hooks.onBlobAnswer(frame.hash, undefined);
    else if (frame.kind === "relayed") fold([frame.wire]);
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
