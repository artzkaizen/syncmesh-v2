import type { StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyDeps, TransportContext } from "@syncmesh/transport";

import { heldRuns } from "@syncmesh/engine";
import { omitUndefined } from "@syncmesh/result";
import { createCustody } from "@syncmesh/transport";

import type { RelayFrame } from "./frames.js";

import { roomRefusalFrame } from "./frames.js";

/**
 * Custody over a relay room (D32, U17): what this device signs for holding and what it refuses go
 * into the session, for the room to hand to the author they name; what arrives about this
 * device's own writes goes to the ledger. The same signer a direct link runs, so a receipt or a
 * refusal says the same thing whichever way it travelled.
 */
export interface RoomCustody {
  /**
   * Folds a batch the room sent, then signs every run that moved and says what the batch parked;
   * a batch the store refused is said through `onDropped` and signs nothing. Without `author` — a
   * re-page's answer below the cursor — it vouches for no run, and still says what it parked.
   */
  readonly fold: (batch: readonly StoredEvent[], author?: PeerId) => Promise<void>;
  /**
   * Signs every run held here that moved since it was last signed, whatever folded it: a recovery
   * run, another link, or a retry a later batch set off.
   */
  readonly moved: () => void;
  /**
   * A peer's cursors arrived, so it is seated: its run is signed again once per position, and what
   * of theirs is parked here and not yet said to this seating is said.
   */
  readonly heard: (peer: PeerId) => void;
  /**
   * The room says `peer` sat down (U38): a new seating, so its run is signed to it again, and
   * every refusal of its writes still parked here is said once more — once per seating, however
   * many cursors frames it sends while it stays.
   */
  readonly seated: (peer: PeerId) => void;
  /**
   * A receipt (a session frame) or a refusal (the room's own tag): verified, and handed on when it
   * is about this device's writes. Whether the frame was one of the two.
   */
  readonly take: (frame: RelayFrame) => boolean;
}

/** The hooks a room's custody needs from the session around it. */
export interface RoomCustodyHooks {
  readonly sendSafe: (frame: Uint8Array) => void;
  readonly onDropped: (why: string) => void;
}

export function createRoomCustody(
  context: TransportContext,
  hooks: RoomCustodyHooks,
  now: () => Temporal.Instant,
): RoomCustody {
  const { engine } = context;
  const send: CustodyDeps["send"] = (_cls, _what, frame) => hooks.sendSafe(frame);
  // a receipt that does not verify is bytes that never became anything, like a bad event
  const errors: CustodyDeps["errors"] = (error) => hooks.onDropped(error.message);
  const custody = createCustody(
    omitUndefined({
      engine,
      identity: context.identity,
      now,
      send,
      errors,
      incarnation: context.incarnation,
      onReceipt: context.onReceipt,
      onRefusal: context.onRefusal,
      // 9 is `hello` on a relay socket: a refusal crosses it under the room's own tag
      refusalFrame: roomRefusalFrame,
    }),
  );
  const self = context.identity.peerId;
  // the run last signed per author, and the run last signed per author while it was seated: a
  // receipt sent while its author is away reaches nobody, and the room keeps none to hand over
  const signed = new Map<PeerId, SeqNum>(heldRuns(engine.coverage()));
  const toSeated = new Map<PeerId, SeqNum>();
  const sign = (author: PeerId, at: SeqNum): void => {
    if (custody.vouch(author)) signed.set(author, at);
  };
  const moved = (): void => {
    for (const [author, at] of heldRuns(engine.coverage()))
      if (author !== self && signed.get(author) !== at) sign(author, at);
  };
  /** Signs `peer`'s run to its seating, unless this seating was already sent that position. */
  const signToSeated = (peer: PeerId, always: boolean): void => {
    const at = heldRuns(engine.coverage()).get(peer);
    if (peer === self || at === undefined || (!always && toSeated.get(peer) === at)) return;
    if (!custody.vouch(peer)) return;
    toSeated.set(peer, at);
    signed.set(peer, at);
  };
  return {
    fold: async (batch, author) => {
      const folded = await engine.receiveBatch(batch);
      // a batch the store did not take is said, and nothing is signed for it
      if (folded.isErr()) return hooks.onDropped(`a batch did not fold: ${folded.error.message}`);
      // durable now, so the claim can be signed — every run the batch moved, the retries it set
      // off included — and what the batch parked said back
      if (author !== undefined) moved();
      custody.refuse(batch);
    },
    moved,
    heard: (peer) => {
      // a write folded while its author was away was signed to nobody: signed again now it is
      // here, once per position, because every peer's cursors would otherwise re-sign every run
      signToSeated(peer, false);
      // still parked and not said to this seating: an author told we hold it above our cursor
      // never re-offers it
      custody.repeat(peer);
    },
    seated: (peer) => {
      custody.reseat(peer);
      signToSeated(peer, true);
      custody.repeat(peer);
    },
    take: (frame) => {
      if (frame.kind === "refusal") custody.receiveRefusal(frame.wire);
      else if (frame.kind === "session" && frame.frame.kind === "receipt")
        custody.receive(frame.frame.wire);
      else return false;
      return true;
    },
  };
}
