import type { Cursors, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { BlobRefusal, TransportContext } from "@syncmesh/transport";
import type { Grant } from "@syncmesh/wire";

import { ownPositionWarning } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { createHoldback, cursorsFrame, eventFrame, grantFrame } from "@syncmesh/transport";
import { decodeAndVerify, relayEnvelope, signEvent } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { JoinedScope } from "./scoped.js";
import type { RelayDial } from "./transport.js";

import { uploadRefusal } from "./blob-channel.js";
import { decodeRelayFrame } from "./frame-decode.js";
import { scopedCoverage } from "./scoped.js";

/** A stored event as bytes to send: this device signs its own, and relays another's verbatim. */
const outgoingEnvelope = (entry: StoredEvent, ctx: TransportContext): Uint8Array | undefined =>
  entry.event.peerId === ctx.identity.peerId
    ? signEvent(entry.event, ctx.identity).wire
    : relayEnvelope(entry);

/**
 * A grant this device registered goes to the room; when it is our own and changes what we may
 * read, the session re-joins so the room serves the new slice (D40).
 */
const passOn =
  (hooks: SessionHooks, self: PeerId) =>
  (grant: Grant, wire: Uint8Array): void => {
    hooks.sendSafe(grantFrame(wire));
    if (grant.device === self && hooks.regranted()) hooks.rejoin();
  };

/** What one wired session may ask of the transport shell around it. */
export interface SessionHooks {
  readonly sendSafe: (frame: Uint8Array) => void;
  /** Any frame re-arms the liveness deadline. */
  readonly rearm: () => void;
  /** Holdback overflow: a fresh join re-pages from our contiguous position. */
  readonly rejoin: () => void;
  /** A challenging room's first frame: what a v2 join has to sign (D33). A sealed link never sends one (D36). */
  readonly onChallenge: (nonce: Uint8Array) => void;
  /** The room said hello: its keepalive, and the lineage of the log it is serving (RFC-0020 §3.2). */
  readonly onHello: (keepaliveMs: number, epoch: string) => void;
  /**
   * The room's log runs at least to `offset`, and everything this device was sent below it has
   * been folded into rows — what `visibleAt` settles on. Called behind the fold chain, never beside
   * it, and held back while the holdback keeps any event behind a hole.
   */
  readonly onPosition?: (offset: number) => void;
  /**
   * The room admits this device under an entitlement other than the one its cursors were earned
   * under (D24). Its cursors may skip what it was refused before, so the session is abandoned and
   * the next join must ask from nothing.
   */
  readonly onReentitled?: () => void;
  /** The relay's typed version refusal is permanent — no reconnect loop against it. */
  readonly onVersionRefused: () => void;
  /** The relay answered a fetch: the bytes, or `undefined` when it holds none under that hash. */
  readonly onBlobAnswer: (hash: string, bytes: Uint8Array | undefined) => void;
  /**
   * The relay answered a put: `undefined` when it kept the bytes, the refusal when it would not.
   * A refusal under a code this build does not know settles as `undefined` too — not kept, but
   * nothing an older client can name, which is what it heard before the answer existed (D14).
   */
  readonly onBlobSettled: (hash: string, refusal: BlobRefusal | undefined) => void;
  /** The last catch-up page has landed: this source has nothing more to hand over right now. */
  readonly onCaughtUp: () => void;
  /**
   * Another device in this room just spoke through the relay, so the relay demonstrably carries it.
   *
   * The evidence a relay has for `Transport.delivers`: it holds one link and cannot enumerate a
   * room, so the only honest thing it can say about a peer is that traffic from them arrived here.
   * Cursors rather than events, deliberately — a relayed event may be history from a device that
   * left hours ago, while cursors are a live peer reporting its position now.
   */
  readonly onPeerHeard?: (peer: PeerId) => void;
  /**
   * Bytes that never became anything (book ch. 18): a frame this build cannot decode, or an event
   * whose signature does not verify.
   *
   * Below a link rather than an ending of one — the socket is still up and the session continues —
   * which is why it is `dropped` and not `closed`. A relay that has started serving another
   * protocol, or one forwarding a peer's forgery, is silent without this.
   */
  readonly onDropped: (why: string) => void;
  /** What this session last joined with, so a coverage scoped to anything else is not adopted. */
  readonly joined: () => JoinedScope;
  /** This device's own grant changed what it may read since the last join (D40). */
  readonly regranted: () => boolean;
  /**
   * This join asked from nothing because the interest widened past what our cursors describe
   * (D23). The pages coming back are a repair, not a tail.
   */
  readonly repaging?: () => boolean;
}

/** The four frames that answer a blob fetch or put (D18). */
type BlobAnswer = Extract<
  RelayFrame,
  { kind: "blob" | "blob-missing" | "blob-stored" | "blob-refused" }
>;

const BLOB_ANSWERS = new Set<RelayFrame["kind"]>([
  "blob",
  "blob-missing",
  "blob-stored",
  "blob-refused",
]);

const isBlobAnswer = (frame: RelayFrame): frame is BlobAnswer => BLOB_ANSWERS.has(frame.kind);

/** The relay answered a fetch or a put: handed to the hook that waits on that hash. */
const answerBlob = (hooks: SessionHooks, frame: BlobAnswer): void => {
  if (frame.kind === "blob") hooks.onBlobAnswer(frame.hash, frame.bytes);
  else if (frame.kind === "blob-missing") hooks.onBlobAnswer(frame.hash, undefined);
  else hooks.onBlobSettled(frame.hash, uploadRefusal(frame));
};

/**
 * The furthest offset a session's frames have carried, said only once the holdback keeps nothing
 * back. Behind the fold chain alone is not enough: an event folded into the holdback was sent but
 * is not a row yet, and a wanted event that a burst puts ahead of its author's pass-over is
 * exactly that until the pass-over lands (D24).
 */
const heldPosition = (
  holdback: ReturnType<typeof createHoldback>,
  say: ((offset: number) => void) | undefined,
) => {
  let unsaid: number | undefined;
  return {
    /** A frame carried `offset`, and everything sent below it has been through the fold chain. */
    reached: (offset: number): void => {
      if (unsaid === undefined || offset > unsaid) unsaid = offset;
    },
    /** Says what was reached, once the holdback has let go of every event it was handed. */
    flush: (): void => {
      if (unsaid === undefined || !holdback.empty()) return;
      const offset = unsaid;
      unsaid = undefined;
      say?.(offset);
    },
  };
};

/**
 * The room's run of our own author, from its `hello`: never number at or below it (RFC 0024 G7).
 * A write this log numbered inside that run is said — it reuses a pair the room holds for another
 * event.
 */
const adoptOwnRun = async (
  engine: TransportContext["engine"],
  own: SeqNum,
  dropped: (why: string) => void,
): Promise<void> => {
  const position = await engine.adoptOwnPosition(own);
  if (position.isErr()) {
    dropped(`the store could not say what this device last wrote: ${position.error.message}`);
    return;
  }
  const warning = ownPositionWarning(position.value);
  if (warning !== undefined) dropped(warning);
};

/** Everything one session subscribes to; the returned unsubscribes are the session's teardown. */
export function wireSession(
  context: TransportContext,
  dialed: RelayDial,
  hooks: SessionHooks,
): readonly Unsubscribe[] {
  const { engine, identity, grants } = context;
  const now = context.now ?? (() => Temporal.Now.instant());
  const holdback = createHoldback(engine, 512);
  let chain: Promise<unknown> = Promise.resolve();
  let caughtUp = false;
  /** Set once this session has been found to hold cursors from another entitlement; nothing after it is acted on. */
  let abandoned = false;
  let relayCursors: Cursors = new Map();

  /** Everything the holdback can let go of for these authors, in run order. */
  const release = async (authors: Iterable<PeerId>): Promise<void> => {
    for (const author of authors) {
      const batch = holdback.drain(author);
      if (batch.length > 0) await engine.receiveBatch(batch);
    }
  };

  /**
   * `direct` skips the holdback, and only a widening re-page sets it.
   *
   * That re-page is being handed a run this device's cursor already claims — the cursor is still
   * the one the old, narrower interest earned — so the gap rule would read every event in it as
   * one already held and drop the very events the re-page exists to deliver. `admit` dedups on
   * what is *stored*, which is the question that actually matters here, and the ordering the
   * holdback would have imposed is the order the relay's pages already arrive in.
   */
  const fold = (wires: readonly Uint8Array[], direct = false): void => {
    chain = chain.then(async () => {
      const authors = new Set<PeerId>();
      const straight: StoredEvent[] = [];
      for (const wire of wires) {
        const verified = decodeAndVerify(wire);
        if (verified.isErr()) {
          // junk from a relay is dropped, never folded — and said, because a relay handing this
          // device unverifiable bytes is a fact about the room and not about this event
          hooks.onDropped(verified.error.message);
          continue;
        }
        if (direct) {
          straight.push(verified.value);
          continue;
        }
        if (holdback.put(verified.value)) {
          hooks.rejoin();
          return;
        }
        authors.add(verified.value.event.peerId);
      }
      if (straight.length > 0) await engine.receiveBatch(straight);
      await release(authors);
      // a fold that emptied the holdback can be what lets a position held back earlier be said
      if (!abandoned) positions.flush();
    });
  };

  const positions = heldPosition(holdback, hooks.onPosition);

  /** Behind the fold chain, and not at all once this session is abandoned. */
  const after = (work: () => Promise<void> | void): void => {
    chain = chain.then(async () => {
      if (abandoned) return;
      await work();
      positions.flush();
    });
  };
  /** Behind the fold chain: everything sent below `offset` is a row by the time it is said. */
  const position = (offset: number): void => after(() => positions.reached(offset));
  const lastPage = scopedCoverage({
    engine,
    holdback,
    joined: hooks.joined,
    after,
    release,
    reentitled: () => {
      abandoned = true;
      hooks.onReentitled?.();
    },
  });

  /**
   * Everything this device holds that the relay does not, whoever wrote it.
   *
   * Not only what this device authored: a peer with a radio and a network is the only way an
   * event written where there is no network ever reaches one, and forwarding is the whole of
   * carrying it. `relayCursors` moves with what is sent so a second call sends the difference
   * rather than the run again — the relay says where it is on `hello`, and between two of those
   * this is what we know it has.
   */
  const pushOutstanding = (): void => {
    chain = chain.then(async () => {
      const entries = await engine.eventsSince(relayCursors);
      if (entries.isErr()) return;
      const sent = new Map(relayCursors);
      for (const entry of entries.value) {
        const wire = outgoingEnvelope(entry, context);
        if (wire === undefined) continue;
        hooks.sendSafe(eventFrame(wire));
        const at = sent.get(entry.event.peerId);
        if (at === undefined || entry.event.seqNum > at)
          sent.set(entry.event.peerId, entry.event.seqNum);
      }
      relayCursors = sent;
    });
  };

  /** The room's run of our own author, on the chain ahead of the pages its hello precedes. */
  const adoptOwn = (cursors: Cursors): void => {
    const own = cursors.get(identity.peerId);
    if (own !== undefined) chain = chain.then(() => adoptOwnRun(engine, own, hooks.onDropped));
  };

  /** Our contiguous position, for every other peer's `delivered`; the relay passes it on. */
  const sendCursors = (): void =>
    hooks.sendSafe(cursorsFrame(identity.peerId, engine.coverage().synced));

  const onSession = (frame: Extract<RelayFrame, { kind: "session" }>["frame"]): void => {
    if (frame.kind === "presence") context.onPresence?.(frame.wire);
    else if (frame.kind === "grant") void grants.register(frame.wire);
    else if (frame.kind === "cursors") {
      hooks.onPeerHeard?.(frame.from);
      engine.acknowledge(frame.from, frame.cursors, now());
    } else if (frame.kind === "grant-request") {
      const request = { peerId: frame.peerId };
      if (frame.invite !== undefined) Object.assign(request, { invite: frame.invite });
      context.onGrantRequest?.(request);
    } else if (frame.kind === "event") fold([frame.wire]);
  };

  const onPage = (frame: Extract<RelayFrame, { kind: "page" }>): void => {
    const asked = hooks.joined();
    for (const wire of frame.grants) void grants.register(wire);
    const repaging = hooks.repaging?.() === true;
    fold(frame.events, repaging);
    if (!frame.more) {
      lastPage(frame.scoped, repaging, asked);
      // only here: every page carries the room's tail, and only the last has delivered up to it
      position(frame.offset);
      // a pass-over (an empty last page after the first) moves a cursor and nothing else
      if (caughtUp && frame.events.length === 0 && frame.grants.length === 0) return;
      caughtUp = true;
      pushOutstanding();
      // behind the chain, not beside it: `fold` and `pushOutstanding` queue their work, so
      // announcing here would announce a pass that has not folded a single event of its last
      // page. What the hook means is "nothing more to hand over right now", and the moment that
      // becomes true is the moment this chain drains
      after(() => hooks.onCaughtUp());
    }
  };

  const offFrame = dialed.onFrame((bytes) => {
    if (abandoned) return;
    hooks.rearm();
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isErr()) {
      hooks.onDropped(decoded.error.message);
      return;
    }
    const frame = decoded.value;
    if (frame.kind === "challenge") hooks.onChallenge(frame.nonce);
    else if (frame.kind === "hello") {
      relayCursors = frame.cursors;
      adoptOwn(frame.cursors);
      hooks.onHello(frame.keepaliveMs, frame.epoch);
    } else if (frame.kind === "page") onPage(frame);
    else if (isBlobAnswer(frame)) answerBlob(hooks, frame);
    else if (frame.kind === "relayed") {
      fold([frame.wire]);
      position(frame.offset);
    } else if (frame.kind === "ack") position(frame.offset);
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
  const offRegistered = grants.onRegistered(passOn(hooks, identity.peerId));
  /**
   * A fold of peers' events moved our position: say so, and hand over what moved it.
   *
   * Saying so alone was the hole. A device that learns an event over Bluetooth and only reports
   * its new cursor tells the relay that something happened and never what — so a peer reachable
   * only over the network never receives it, from anyone, ever. `pushOutstanding` sends the
   * difference, which is nothing at all when the relay already had it.
   */
  const offFolds = engine.onFoldBatch((batch) => {
    if (!caughtUp || batch.source !== "remote") return;
    pushOutstanding();
    sendCursors();
  });
  return [offFrame, offOutbound, offRegistered, offFolds];
}
