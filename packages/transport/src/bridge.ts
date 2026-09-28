import type { Ahead, Engine, Interest, Unsubscribe } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { CustodyReceipt, EventCrypto, GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub, heldAhead, interestKey } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { decodeAndVerify, signEvent } from "@syncmesh/wire";

import type { Divergence } from "./divergence.js";
import type { FrameClass } from "./frame-parts.js";
import type { JoinDeps, JoinExchange, SnapshotInstalled } from "./join.js";
import type { FrameLink } from "./link.js";
import type { BridgeError, OutboundDeps } from "./outbound.js";
import type { RouteTable } from "./routes.js";
import type { SnapshotFrame } from "./snap-frame.js";

import { controlFrames, custodyFor } from "./custody.js";
import { createDispatch } from "./dispatch.js";
import { answerDigest } from "./divergence.js";
import { KIND } from "./frame-parts.js";
import { decodeFrame, eventFrame, grantFrame, grantRequestFrame, presenceFrame } from "./frame.js";
import { createHoldback } from "./holdback.js";
import { createJoinExchange } from "./join.js";
import { createOutbound } from "./outbound.js";
import { createRouteExchange } from "./route-exchange.js";

export type { BridgeError } from "./outbound.js";
export { SendFailed, Unsendable } from "./outbound.js";

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
  /**
   * Whether this link is the one to carry a frame (E28). Absent, it carries everything — which
   * is what every link did before link admission, and what a link whose peer is not yet known
   * must keep doing.
   *
   * Only events are asked. Grants, cursors and the rest of the exchange are what makes a link a
   * link, and a link that stopped exchanging them to save a send would stop being one.
   */
  readonly carries?: (message: { readonly cls: FrameClass; readonly bytes: number }) => boolean;
  /** Out-of-order events held per author before a resync is forced. Default 512. */
  readonly gapLimit?: number;
  /** An ephemeral value arrived (D16): the store decides whether it is news. Never stored here. */
  readonly onPresence?: (wire: Uint8Array) => void;
  /**
   * The slice this link syncs. A digest exchange compares only when both sides name the
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
  /** This device's checkpoint certificate, relayed with any state it sends (book ch. 4). */
  readonly certificate?: () => Uint8Array | undefined;
  /**
   * This device's storage lineage, for the custody receipts it signs (book ch. 10). A device
   * that lost its database and rebuilt announces a fresh one, so an author can tell "still
   * holding" from "holding again, having lost what it had". Absent, no receipt is issued —
   * signing custody without being able to say *which* store held it proves less than nothing.
   */
  readonly incarnation?: string;
  /** A verified receipt arrived for one of this device's own writes. */
  readonly onReceipt?: (receipt: CustodyReceipt) => void;
  /**
   * This device's routing table (book ch. 17). Given one, the bridge advertises what this
   * device can reach when the session opens, learns what the far side can, and forgets every
   * route through that peer when the link closes. Absent, nothing routes beyond one hop.
   */
  readonly routes?: RouteTable;
  /**
   * What this device can seal and open (book ch. 14). Given a key ring, an event in a sealed
   * partition leaves as an opaque payload and an arriving one is opened where a key exists.
   *
   * Absent, everything travels and arrives in the clear — which is what a device with no sealed
   * partition does, and what a relay does for one it holds no key for: it carries the envelope
   * whole, folds nothing out of it, and cannot read a value in it.
   */
  readonly crypto?: EventCrypto;
  /** Whose checkpoint this device will believe; absent, every snapshot install stays provisional. */
  readonly trust?: PeerId;
  /**
   * The far side's fingerprints disagreed with ours for these tables, over a slice we both
   * named (RFC-0014). Repair is the caller's to run — `rowDigests` narrows it to rows.
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
  readonly requestSnapshot: (interest?: Interest, adoptUnvouched?: boolean) => void;
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

/** The join exchange for one session, carrying only the options the caller actually set. */
const joinFor = (options: BridgeOptions, send: JoinDeps["send"]): JoinExchange => {
  const { engine, identity, rowsPerChunk, onSnapshot, certificate, trust } = options;
  const base = { engine, send, idPrefix: identity.peerId.slice(0, 8) };
  const paged = rowsPerChunk === undefined ? base : { ...base, rowsPerChunk };
  const reported = onSnapshot === undefined ? paged : { ...paged, onSnapshot };
  const vouching = certificate === undefined ? reported : { ...reported, certificate };
  return createJoinExchange(trust === undefined ? vouching : { ...vouching, trust });
};

/**
 * Signs the event and offers it to this link, unless routing put it on another one (E28).
 *
 * The size weighed is the **frame's**, not the event's: what occupies a medium is what goes on it.
 * An absent `carries` emits — a link with no routing behind it carries everything, which is what
 * every link did before link admission and what one whose peer is unknown must keep doing.
 */
const offerEvent = (
  event: SyncEvent,
  identity: Identity,
  carries: BridgeOptions["carries"],
  emit: (frame: Uint8Array) => void,
  crypto?: EventCrypto,
): void => {
  const frame = eventFrame(signEvent(event, identity, crypto).wire);
  if (carries?.({ cls: KIND.event, bytes: frame.length }) !== false) emit(frame);
};

/** What the outbound half needs, assembled so an absent capability stays absent (D12-A). */
const outboundFor = (
  link: FrameLink,
  options: BridgeOptions,
  scope: string,
  errors: OutboundDeps["errors"],
): OutboundDeps => ({
  link,
  engine: options.engine,
  identity: options.identity,
  interest: options.interest,
  scope,
  errors,
  ...(options.crypto !== undefined && { crypto: options.crypto }),
});

/**
 * They hold an author ahead of us: answering with our cursors is the request for the diff.
 *
 * Our own events are skipped, because a peer ahead of us on *us* is holding something we
 * authored and have since lost — a real case, and not one more cursors would fix.
 */
const isBehind = (engine: Engine, self: PeerId, theirs: ReadonlyMap<PeerId, SeqNum>): boolean => {
  const ours = engine.coverage().synced;
  for (const [author, seq] of theirs)
    if (author !== self && (ours.get(author) ?? 0) < seq) return true;
  return false;
};

export function bridgeFramedLink(link: FrameLink, options: BridgeOptions): Bridge {
  const { engine, identity, grants, onPresence, gapLimit = 512, routes } = options;
  const { interest, onDivergence, carries } = options;
  const scope = interestKey(interest ?? {});
  const now = options.now ?? (() => Temporal.Now.instant());
  const errors = createHub<BridgeError>();
  const reportError = (error: BridgeError): void => errors.emit(error);
  const sendReceipt = (frame: Uint8Array): void => send(KIND.receipt, "receipt", frame);
  const custody = custodyFor(options, { now, send: sendReceipt, errors: reportError });
  const control = controlFrames(options, { custody, errors: reportError });
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** Whose link this is, learned from the cursors they send; `undefined` until they speak. */
  let farSide: PeerId | undefined;
  let sentCursors = false;

  const routing = createRouteExchange({ farSide: () => farSide, routes });
  const out = createOutbound(outboundFor(link, options, scope, errors));
  const { send, drain, envelopeOf, sendDigest, cursorsAfter } = out;
  const sendCursors = (): void => void (queue = cursorsAfter(queue));

  // every frame of the exchange travels under the one snapshot tag, so they stay in the order
  // the exchange needs — a page ahead of the manifest that names it is a page thrown away
  const join = joinFor(options, (what, bytes) => send(KIND.snapshot, what, bytes));

  const holdback = createHoldback(engine, identity.peerId, gapLimit);
  const receiveEvent = (wire: Uint8Array): void => {
    const verified = decodeAndVerify(wire, options.crypto);
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
      const author = verified.value.event.peerId;
      const ready = holdback.drain(author);
      if (ready.length === 0) return;
      const r = await engine.receiveBatch(ready);
      if (r.isErr()) {
        errors.emit(r.error);
        return;
      }
      // durable now, so the claim can be signed: a cursor says this and proves none of it
      custody.vouch(author);
    });
  };

  const onCursors = (
    from: PeerId,
    theirs: ReadonlyMap<PeerId, SeqNum>,
    theirAhead: Ahead | undefined,
  ): void => {
    // the far side names itself in its cursors; that is how this link learns whose it is
    farSide = from;
    engine.acknowledge(from, theirs, now());
    queue = queue.then(async () => {
      const entries = await engine.eventsSince(theirs);
      if (entries.isErr()) {
        errors.emit(entries.error);
        return;
      }
      // an event they said they already hold above their cursor is not sent again: without that,
      // a peer parking one event it cannot read (D13) is sent the whole tail above the hole on
      // every exchange, and answers with the same cursor every time
      for (const entry of entries.value.filter((e) => !heldAhead(theirAhead, e))) {
        const wire = envelopeOf(entry);
        if (wire !== undefined) send(KIND.event, "event", eventFrame(wire));
      }
      sendDigest();
      if (!sentCursors || isBehind(engine, identity.peerId, theirs)) {
        sentCursors = true;
        sendCursors();
      }
    });
  };

  const digestDeps = {
    engine,
    identity,
    interest,
    scope,
    queued: (run: () => void) => void (queue = queue.then(run)),
  };
  if (onDivergence !== undefined) Object.assign(digestDeps, { onDivergence });
  const onDigest = answerDigest(digestDeps);

  const dispatchHandlers = {
    queued: (run: () => Promise<void> | void) => void (queue = queue.then(run)),
    onCursors,
    onEvent: receiveEvent,
    onDigest,
    onSnapshot: (frame: SnapshotFrame) => join.dispatch(frame),
    routing,
    control,
  };
  if (onPresence !== undefined) Object.assign(dispatchHandlers, { onPresence });
  const dispatch = createDispatch(dispatchHandlers);

  const offFrame = link.onFrame((bytes) => {
    if (closed) return;
    const frame = decodeFrame(bytes);
    if (frame.isErr()) errors.emit(frame.error);
    else dispatch(frame.value);
  });

  /** A newly learned grant propagates live — including the answer to a grant-request. */
  const offRegistered = grants.onRegistered((_grant, wire) =>
    send(KIND.grant, "grant", grantFrame(wire)),
  );
  const offOutbound = engine.onOutbound((event: SyncEvent) =>
    offerEvent(
      event,
      identity,
      carries,
      (frame) => send(KIND.event, "event", frame),
      options.crypto,
    ),
  );
  /** A remote fold means this engine now holds more than its other neighbors may: announce, so they request. */
  const offFolds = engine.onFoldBatch((batch) => {
    if (batch.source === "remote") sendCursors();
  });

  /**
   * Queued, so the events that arrived with the digest are folded before it is answered — which
   * is what makes it the last frame of the exchange rather than merely the last one sent.
   */
  const resync = (): void => {
    sentCursors = true;
    sendCursors();
  };

  /** What this device can reach, as the far side should record it: split horizon applied. */
  const sendRoutes = (): void => {
    if (closed) return;
    const frame = routing.advertisement();
    if (frame !== undefined) send(KIND.routes, "routes", frame);
  };

  /**
   * Queued behind the cursors rather than sent beside them. The cursors go out on the work
   * queue — they read the log first — so a synchronous advertisement would overtake them and
   * arrive at a peer that has not yet learned whose link this is, which drops it.
   */
  const scheduleRoutes = (): void => void (queue = queue.then(sendRoutes));

  // session open: grants first, always; then our cursors, which is how the far side learns
  // whose link this is; then our routes, which are meaningless until it does — an ad that
  // arrives before the cursors names a next hop the receiver cannot identify, and is dropped.
  for (const wire of grants.allWires()) send(KIND.grant, "grant", grantFrame(wire));
  resync();
  scheduleRoutes();
  // a route learned on another link is one this peer may want: that is how a chain converges
  const offRoutes = routes?.onChange(scheduleRoutes) ?? (() => undefined);

  return {
    resync,
    requestSnapshot: join.request,
    requestGrant: (invite) =>
      send(KIND.grantRequest, "grant-request", grantRequestFrame(identity.peerId, invite)),
    sendGrant: (wire) => send(KIND.grant, "grant", grantFrame(wire)),
    // ordered after the events, and its failure swallowed rather than reported: on a full radio
    // a dropped ephemeral is the correct outcome, not an error (D16)
    sendPresence: (wire) => send(KIND.presence, "presence", presenceFrame(wire)),
    onError: errors.subscribe,
    flush: async () => {
      drain();
      await queue;
      drain();
    },
    close: () => {
      // what was offered still leaves: a frame dropped here would be one no resync knows to ask
      // for, and the link is the only thing entitled to refuse it
      drain();
      closed = true;
      offFrame();
      offRegistered();
      offOutbound();
      offFolds();
      offRoutes();
      // this link is gone, so every route that went through it is: the next attempt re-routes
      routing.lost();
      link.close?.();
    },
  };
}
