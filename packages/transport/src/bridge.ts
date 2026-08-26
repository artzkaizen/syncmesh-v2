import type { Engine, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub } from "@syncmesh/engine";
import { TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { decodeAndVerify, encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

import type { FrameLink } from "./link.js";

import {
  cursorsFrame,
  decodeFrame,
  eventFrame,
  grantFrame,
  grantRequestFrame,
  presenceFrame,
} from "./frame.js";
import { createHoldback } from "./holdback.js";

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
  /** An ephemeral value arrived (D16): the store decides whether it is news. Never stored here. */
  readonly onPresence?: (wire: Uint8Array) => void;
}

/** One session over one link: grants first, then cursors, then events — with the gap rule. */
export interface Bridge {
  /** Re-requests from our last contiguous position; the recovery for any lost frame. */
  readonly resync: () => void;
  /** Asks the far side for a grant for this device (flow A step ②). */
  readonly requestGrant: (invite?: string) => void;
  /** Sends one grant's wire bytes now (the answer to a request). */
  readonly sendGrant: (wire: Uint8Array) => void;
  /** Sends one ephemeral value, byte-identical; a failure is dropped, never queued (D16). */
  readonly sendPresence: (wire: Uint8Array) => void;
  readonly onError: (cb: (error: BridgeError) => void) => Unsubscribe;
  /** Everything received so far is folded. */
  readonly flush: () => Promise<void>;
  readonly close: () => void;
}

export function bridgeFramedLink(link: FrameLink, options: BridgeOptions): Bridge {
  const { engine, identity, grants, onGrantRequest, onPresence, gapLimit = 512 } = options;
  const now = options.now ?? (() => Temporal.Now.instant());
  const errors = createHub<BridgeError>();
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
    errors.emit(
      new Unsendable({ id: String(entry.event.id), message: "no stored signature to relay" }),
    );
    return undefined;
  };

  const sendCursors = (): void => {
    queue = queue.then(async () => {
      const cursors = await engine.cursors();
      if (cursors.isOk())
        guard("cursors", () => link.send(cursorsFrame(identity.peerId, cursors.value)));
    });
  };

  const holdback = createHoldback(engine, identity.peerId, gapLimit);
  const receiveEvent = (wire: Uint8Array): void => {
    const verified = decodeAndVerify(wire);
    if (verified.isErr()) {
      errors.emit(verified.error);
      return;
    }
    const overflow = holdback.put(verified.value);
    if (overflow) {
      resync();
      return;
    }
    queue = queue.then(async () => {
      const ready = holdback.drain(verified.value.event.peerId);
      if (ready.length === 0) return;
      const r = await engine.receiveBatch(ready);
      if (r.isErr()) errors.emit(r.error);
    });
  };

  /** They hold an author ahead of us: answering with our cursors is the request for the diff. */
  const behind = (theirs: ReadonlyMap<PeerId, SeqNum>): boolean => {
    const ours = engine.coverage().synced;
    for (const [author, seq] of theirs) {
      if (author !== identity.peerId && (ours.get(author) ?? 0) < seq) return true;
    }
    return false;
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
      if (!sentCursors || behind(theirs)) {
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
      case "presence":
        onPresence?.(frame.value.wire);
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
  /** A remote fold means this engine now holds more than its other neighbors may: announce, so they request. */
  const offFolds = engine.onFoldBatch((batch) => {
    if (batch.source === "remote") sendCursors();
  });

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
    sendPresence: (wire) => {
      // never `guard`: a dropped cursor is the correct outcome on a full radio, not an error
      try {
        link.send(presenceFrame(wire));
      } catch {
        /* the next value replaces it */
      }
    },
    onError: errors.subscribe,
    flush: async () => void (await queue),
    close: () => {
      closed = true;
      offFrame();
      offRegistered();
      offOutbound();
      offFolds();
      link.close?.();
    },
  };
}
