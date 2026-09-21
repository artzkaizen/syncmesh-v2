import type { Coverage, Cursors, Interest, StoredEvent, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { interestText } from "@syncmesh/engine";
import { Temporal } from "@syncmesh/temporal";
import { createHoldback, cursorsFrame, eventFrame, grantFrame } from "@syncmesh/transport";
import { decodeAndVerify, relayEnvelope, signEvent } from "@syncmesh/wire";

import type { RelayFrame } from "./frames.js";
import type { RelayDial } from "./transport.js";

import { decodeRelayFrame } from "./frames.js";

/** A stored event as bytes to send: this device signs its own, and relays another's verbatim. */
const envelopeOf = (entry: StoredEvent, ctx: TransportContext): Uint8Array | undefined =>
  entry.event.peerId === ctx.identity.peerId
    ? signEvent(entry.event, ctx.identity).wire
    : relayEnvelope(entry);

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
  /** What this session joined with, so a coverage scoped to something else is not adopted. */
  readonly interest?: Interest;
  /**
   * This join asked from nothing because the interest widened past what our cursors describe
   * (D23). The pages coming back are a repair, not a tail.
   */
  readonly repaging?: () => boolean;
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
    });
  };

  /**
   * Takes on the coverage a filtered catch-up ended with (D23) — behind the fold chain, so the
   * events it accounts for are folded before this device claims to hold them, exactly as
   * `installSnapshot` adopts a snapshot's coverage only after its rows.
   *
   * A coverage scoped to something other than what we asked with is dropped rather than adopted.
   * It would be a claim about a slice this device did not request, and adopting it is precisely
   * how a cursor comes to describe events nobody will ever send again.
   */
  const adoptScoped = (scoped: Coverage): void => {
    if (scoped.scope !== interestText(hooks.interest)) return;
    chain = chain.then(async () => {
      // fold what the coverage is about to claim *before* claiming it — the order
      // `installSnapshot` keeps for its rows, and for the same reason. These are events the pages
      // did deliver, which the holdback kept behind a hole the filter made and nothing will fill
      for (const [author, seq] of scoped.synced) {
        const held = holdback.upTo(author, Number(seq));
        if (held.length > 0) await engine.receiveBatch(held);
      }
      engine.adoptCoverage(scoped);
      // and then whatever sat above it, which the moved cursor has just made contiguous
      await release(scoped.synced.keys());
    });
  };

  /**
   * After a widening re-page that the relay did not filter: the cursors this device holds are
   * now true for the wider interest, because the repair ran from nothing and delivered the whole
   * run. Saying so is what stops the next join re-paging the same history again.
   */
  const rescope = (): void => {
    chain = chain.then(() => {
      const { synced, local } = engine.coverage();
      const scope = interestText(hooks.interest);
      // rebuilt rather than spread, so an interest that widened all the way back to everything
      // drops the old scope instead of carrying it forward
      engine.adoptCoverage(scope === "" ? { synced, local } : { synced, local, scope });
    });
  };

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
        const wire = envelopeOf(entry, context);
        if (wire === undefined) continue;
        hooks.sendSafe(eventFrame(wire));
        const at = sent.get(entry.event.peerId);
        if (at === undefined || entry.event.seqNum > at)
          sent.set(entry.event.peerId, entry.event.seqNum);
      }
      relayCursors = sent;
    });
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

  const offFrame = dialed.onFrame((bytes) => {
    hooks.rearm();
    const decoded = decodeRelayFrame(bytes);
    if (decoded.isErr()) {
      hooks.onDropped(decoded.error.message);
      return;
    }
    const frame = decoded.value;
    if (frame.kind === "hello") {
      relayCursors = frame.cursors;
      hooks.onHello(frame.keepaliveMs);
    } else if (frame.kind === "page") {
      for (const wire of frame.grants) void grants.register(wire);
      const repaging = hooks.repaging?.() === true;
      fold(frame.events, repaging);
      if (!frame.more) {
        if (frame.scoped !== undefined) adoptScoped(frame.scoped);
        else if (repaging) rescope();
        caughtUp = true;
        pushOutstanding();
        // behind the chain, not beside it: `fold` and `pushOutstanding` queue their work, so
        // announcing here would announce a pass that has not folded a single event of its last
        // page. What the hook means is "nothing more to hand over right now", and the moment that
        // becomes true is the moment this chain drains
        chain = chain.then(() => hooks.onCaughtUp());
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
