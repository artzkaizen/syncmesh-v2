import type { Engine, Hub, Interest, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub, interestKey } from "@syncmesh/engine";
import { TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { decodeAndVerify, encodeCbor, encodeEventCore, signEvent } from "@syncmesh/wire";

import type { Divergence } from "./divergence.js";
import type { Frame } from "./frame.js";
import type { JoinDeps, JoinExchange, SnapshotInstalled } from "./join.js";
import type { FrameLink } from "./link.js";
import type { SnapshotFrame } from "./snap-frame.js";

import { divergenceAgainst, tableNames } from "./divergence.js";
import {
  cursorsFrame,
  decodeFrame,
  digestFrame,
  eventFrame,
  grantFrame,
  grantRequestFrame,
  presenceFrame,
} from "./frame.js";
import { createHoldback } from "./holdback.js";
import { createJoinExchange } from "./join.js";

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
  /**
   * The slice this link syncs (E13). A digest exchange compares only when both sides name the
   * same one, so two peers holding different partitions never mistake that for divergence.
   */
  readonly interest?: Interest;
  /**
   * A join completed (RFC-0019): state arrived instead of history, and the coverage behind it is
   * now adopted. `provisional` says what it cost — the rows carried no per-event signatures.
   */
  readonly onSnapshot?: (installed: SnapshotInstalled) => void;
  /** Rows per page of a served snapshot; one page should be a reasonable write on a slow radio. */
  readonly rowsPerChunk?: number;
  /**
   * The far side's fingerprints disagreed with ours for these tables, over a slice we both
   * named (E16, RFC-0014). Repair is the caller's to run — `rowDigests` narrows it to rows.
   */
  readonly onDivergence?: (report: Divergence) => void;
}

/** One session over one link: grants first, then cursors, then events — with the gap rule. */
export interface Bridge {
  /** Re-requests from our last contiguous position; the recovery for any lost frame. */
  readonly resync: () => void;
  /**
   * Asks for state instead of history (RFC-0019). What a device with no log does on its first
   * session: the rows it is entitled to, and the coverage they stand for, rather than every
   * event that ever produced them.
   */
  readonly requestSnapshot: (interest?: Interest) => void;
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

/** The four sub-kinds of the join exchange, which the bridge hands on whole rather than case by case. */
const isSnapshotFrame = (frame: Frame): frame is SnapshotFrame => frame.kind.startsWith("snap-");

/** The join exchange for one session, carrying only the options the caller actually set. */
const joinFor = (options: BridgeOptions, send: JoinDeps["send"]): JoinExchange => {
  const { engine, identity, rowsPerChunk, onSnapshot } = options;
  const base = { engine, send, idPrefix: identity.peerId.slice(0, 8) };
  const paged = rowsPerChunk === undefined ? base : { ...base, rowsPerChunk };
  return createJoinExchange(onSnapshot === undefined ? paged : { ...paged, onSnapshot });
};

/** What one link sends, and the one place a send that failed becomes a reported error. */
interface OutboundDeps {
  readonly link: FrameLink;
  readonly engine: Engine;
  readonly identity: Identity;
  readonly interest: Interest | undefined;
  readonly scope: string;
  readonly errors: Hub<BridgeError>;
}

/**
 * The sending half of a session. Kept apart from the receiving half because the two have almost
 * nothing to say to each other: everything here turns state we already hold into bytes, and a
 * failure to send is reported rather than thrown — a loud failure is recoverable by resync, a
 * silent one is divergence (RFC-0005).
 */
function createOutbound(deps: OutboundDeps) {
  const { link, engine, identity, interest, scope, errors } = deps;

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (cause) {
      errors.emit(new SendFailed({ message: `${what} did not leave`, cause }));
    }
  };

  /** This device signs its own events; another peer's is relayed with the signature it came with. */
  const envelopeOf = (entry: StoredEvent): Uint8Array | undefined => {
    if (entry.event.peerId === identity.peerId) return signEvent(entry.event, identity).wire;
    if (entry.sig !== undefined) return encodeCbor([encodeEventCore(entry.event), entry.sig]);
    errors.emit(
      new Unsendable({ id: String(entry.event.id), message: "no stored signature to relay" }),
    );
    return undefined;
  };

  /**
   * What we hold, counted after the events we owed them have gone out and stamped with what we
   * had folded when we counted — the two facts that let the far side tell divergence from a peer
   * that is merely behind (E16).
   */
  const sendDigest = (): void => {
    guard("digest", () =>
      link.send(digestFrame(scope, engine.coverage().synced, tableNames(engine.digest(interest)))),
    );
  };

  /** Our contiguous position, sent once whatever the caller is already doing has finished. */
  const cursorsAfter = (queue: Promise<unknown>): Promise<void> =>
    queue.then(async () => {
      const cursors = await engine.cursors();
      if (cursors.isOk())
        guard("cursors", () => link.send(cursorsFrame(identity.peerId, cursors.value)));
    });

  return { guard, envelopeOf, sendDigest, cursorsAfter };
}

export function bridgeFramedLink(link: FrameLink, options: BridgeOptions): Bridge {
  const { engine, identity, grants, onGrantRequest, onPresence, gapLimit = 512 } = options;
  const { interest, onDivergence } = options;
  const scope = interestKey(interest ?? {});
  const now = options.now ?? (() => Temporal.Now.instant());
  const errors = createHub<BridgeError>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let sentCursors = false;

  const out = createOutbound({ link, engine, identity, interest, scope, errors });
  const { guard, envelopeOf, sendDigest, cursorsAfter } = out;
  const sendCursors = (): void => void (queue = cursorsAfter(queue));

  const join = joinFor(options, (what, bytes) => guard(what, () => link.send(bytes)));

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
      sendDigest();
      if (!sentCursors || behind(theirs)) {
        sentCursors = true;
        sendCursors();
      }
    });
  };

  /** One arriving frame to the handler that owns it; an unknown kind is ignored, never an error. */
  const dispatch = (frame: Frame): void => {
    // the join exchange is queued behind the events for the same reason a digest is: an install
    // that raced the fold would adopt a coverage the state has not caught up with
    if (isSnapshotFrame(frame)) {
      queue = queue.then(() => join.dispatch(frame));
      return;
    }
    switch (frame.kind) {
      case "grant": {
        const registered = grants.register(frame.wire);
        if (registered.isErr()) errors.emit(registered.error);
        return;
      }
      case "grant-request": {
        const request = { peerId: frame.peerId };
        if (frame.invite !== undefined) Object.assign(request, { invite: frame.invite });
        onGrantRequest?.(request);
        return;
      }
      case "cursors":
        return onCursors(frame.from, frame.cursors);
      case "event":
        return receiveEvent(frame.wire);
      case "presence":
        return onPresence?.(frame.wire);
      case "digest":
        return onDigest(frame.scope, frame.at, frame.digests);
      case "unknown":
        return;
    }
  };

  const offFrame = link.onFrame((bytes) => {
    if (closed) return;
    const frame = decodeFrame(bytes);
    if (frame.isErr()) errors.emit(frame.error);
    else dispatch(frame.value);
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

  /**
   * Queued, so the events that arrived with the digest are folded before it is answered — which
   * is what makes it the last frame of the exchange rather than merely the last one sent.
   */
  const onDigest = (
    scopeThere: string,
    at: ReadonlyMap<PeerId, SeqNum>,
    digests: ReadonlyMap<string, bigint>,
  ): void => {
    if (onDivergence === undefined) return;
    queue = queue.then(() => {
      const tables = divergenceAgainst(engine, interest, scope, { scope: scopeThere, at, digests });
      if (tables !== undefined && tables.length > 0)
        onDivergence({ peer: identity.peerId, scope, tables });
    });
  };

  const resync = (): void => {
    sentCursors = true;
    sendCursors();
  };

  // session open: every grant we hold, then our cursors — grants first, always.
  for (const wire of grants.allWires()) guard("grant", () => link.send(grantFrame(wire)));
  resync();

  return {
    resync,
    requestSnapshot: join.request,
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
