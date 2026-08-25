import type { Engine, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub } from "@syncmesh/engine";
import { TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { decodeAndVerify, encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

import type { FrameLink } from "./link.js";

import { cursorsFrame, decodeFrame, eventFrame, grantFrame, grantRequestFrame } from "./frame.js";

/** A relayed event whose author's signature was never stored cannot leave — nobody else can sign it. */
export class Unsendable extends TaggedError("Unsendable")<{ id: string; message: string }> {}

export class SendFailed extends TaggedError("SendFailed")<{ message: string; cause: unknown }> {}

export type BridgeError =
  | Unsendable
  | SendFailed
  | { readonly _tag: string; readonly message: string };

export interface BridgeOptions {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly grants: GrantRegistry;
  readonly now?: () => Temporal.Instant;
  /** An ungranted peer asked to exist (flow A/B): forward it, or answer with `sendGrant`. Untrusted by definition. */
  readonly onGrantRequest?: (request: {
    readonly peerId: PeerId;
    readonly invite?: string;
  }) => void;
  /** Out-of-order events held per author before a resync is forced. Default 512. */
  readonly gapLimit?: number;
}

/** One session over one link: grants first, then cursors, then events — with the gap rule. */
export interface Bridge {
  /** Re-requests from our last contiguous position; the recovery for any lost frame. */
  readonly resync: () => void;
  /** Asks the far side for a grant for this device (flow A step ②). */
  readonly requestGrant: (invite?: string) => void;
  /** Sends one grant's wire bytes now (the answer to a request). */
  readonly sendGrant: (wire: Uint8Array) => void;
  readonly onError: (cb: (error: BridgeError) => void) => Unsubscribe;
  /** Everything received so far is folded. */
  readonly flush: () => Promise<void>;
  readonly close: () => void;
}

export function bridgeFramedLink(link: FrameLink, options: BridgeOptions): Bridge {
  const { engine, identity, grants, onGrantRequest, gapLimit = 512 } = options;
  const now = options.now ?? (() => Temporal.Now.instant());
  const errors = createHub<BridgeError>();
  /** Out-of-order holdback, per author: the gap rule. Max-based cursors would jump a lost frame. */
  const held = new Map<PeerId, Map<number, StoredEvent>>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let sentCursors = false;

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (cause) {
      errors.emit(new SendFailed({ message: `${what} did not leave`, cause }));
    }
  };

  const envelopeOf = (entry: StoredEvent): Uint8Array | undefined => {
    if (entry.event.peerId === identity.peerId) return signEvent(entry.event, identity).wire;
    if (entry.sig !== undefined) return encodeCbor([encodeEventCore(entry.event), entry.sig]);
    errors.emit(new Unsendable({ id: entry.event.id, message: "no stored signature to relay" }));
    return undefined;
  };

  const sendCursors = (): void => {
    queue = queue.then(async () => {
      const cursors = await engine.cursors();
      if (cursors.isOk())
        guard("cursors", () => link.send(cursorsFrame(identity.peerId, cursors.value)));
    });
  };

  const contiguous = (author: PeerId): number => Number(engine.coverage().synced.get(author) ?? 0);

  const drain = (author: PeerId): readonly StoredEvent[] => {
    const buffer = held.get(author);
    if (buffer === undefined) return [];
    const ready: StoredEvent[] = [];
    let next = contiguous(author) + 1;
    for (;;) {
      const entry = buffer.get(next);
      if (entry === undefined) break;
      buffer.delete(next);
      ready.push(entry);
      next += 1;
    }
    if (buffer.size === 0) held.delete(author);
    return ready;
  };

  const receiveEvent = (wire: Uint8Array): void => {
    const verified = decodeAndVerify(wire);
    if (verified.isErr()) {
      errors.emit(verified.error);
      return;
    }
    const { event, sig } = verified.value;
    const seq = Number(event.seqNum);
    if (event.peerId === identity.peerId || seq <= contiguous(event.peerId)) return;
    const buffer = held.get(event.peerId) ?? new Map<number, StoredEvent>();
    buffer.set(seq, { event, sig });
    held.set(event.peerId, buffer);
    if (buffer.size > gapLimit) {
      buffer.clear();
      resync();
      return;
    }
    queue = queue.then(async () => {
      const ready = drain(event.peerId);
      if (ready.length === 0) return;
      const r = await engine.receiveBatch(ready);
      if (r.isErr()) errors.emit(r.error);
    });
  };

  const onCursors = (from: PeerId, theirs: ReadonlyMap<PeerId, SeqNum>): void => {
    engine.acknowledge(from, theirs, now());
    queue = queue.then(async () => {
      const entries = await engine.eventsSince(theirs);
      if (entries.isErr()) {
        errors.emit(entries.error);
        return;
      }
      for (const entry of entries.value) {
        const wire = envelopeOf(entry);
        if (wire !== undefined) guard("event", () => link.send(eventFrame(wire)));
      }
      if (!sentCursors) {
        sentCursors = true;
        sendCursors();
      }
    });
  };

  const offFrame = link.onFrame((bytes) => {
    if (closed) return;
    const frame = decodeFrame(bytes);
    if (frame.isErr()) {
      errors.emit(frame.error);
      return;
    }
    switch (frame.value.kind) {
      case "grant": {
        const registered = grants.register(frame.value.wire);
        if (registered.isErr()) errors.emit(registered.error);
        return;
      }
      case "grant-request": {
        const request = { peerId: frame.value.peerId };
        if (frame.value.invite !== undefined)
          Object.assign(request, { invite: frame.value.invite });
        onGrantRequest?.(request);
        return;
      }
      case "cursors":
        onCursors(frame.value.from, frame.value.cursors);
        return;
      case "event":
        receiveEvent(frame.value.wire);
        return;
      case "unknown":
        return;
    }
  });

  /** A newly learned grant propagates live — including the answer to a grant-request. */
  const offRegistered = grants.onRegistered((_grant, wire) =>
    guard("grant", () => link.send(grantFrame(wire))),
  );
  const offOutbound = engine.onOutbound((event: SyncEvent) =>
    guard("event", () => link.send(eventFrame(signEvent(event, identity).wire))),
  );

  const resync = (): void => {
    sentCursors = true;
    sendCursors();
  };

  // session open: every grant we hold, then our cursors — grants first, always.
  for (const wire of grants.allWires()) guard("grant", () => link.send(grantFrame(wire)));
  resync();

  return {
    resync,
    requestGrant: (invite) =>
      guard("grant-request", () => link.send(grantRequestFrame(identity.peerId, invite))),
    sendGrant: (wire) => guard("grant", () => link.send(grantFrame(wire))),
    onError: errors.subscribe,
    flush: async () => void (await queue),
    close: () => {
      closed = true;
      offFrame();
      offRegistered();
      offOutbound();
      link.close?.();
    },
  };
}
