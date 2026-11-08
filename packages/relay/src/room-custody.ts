import type { StoredEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyDeps, TransportContext } from "@syncmesh/transport";

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
   * Folds a batch the room sent, then signs what is now held of `author` and says what the batch
   * parked; a batch the store refused is said through `onDropped` and signs nothing. Without `author` — a re-page's answer below the cursor — it vouches for no run, and
   * still says what it parked.
   */
  readonly fold: (batch: readonly StoredEvent[], author?: PeerId) => Promise<void>;
  /** A peer's cursors arrived: what of theirs is still parked here is said again. */
  readonly heard: (peer: PeerId) => void;
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
  return {
    fold: async (batch, author) => {
      const folded = await engine.receiveBatch(batch);
      // a batch the store did not take is said, and nothing is signed for it
      if (folded.isErr()) return hooks.onDropped(`a batch did not fold: ${folded.error.message}`);
      // durable now, so the claim can be signed, and what the batch parked said back
      if (author !== undefined) custody.vouch(author);
      custody.refuse(batch);
    },
    // still parked, said again: an author told we hold it above our cursor never re-offers it
    heard: (peer) => custody.repeat(peer),
    take: (frame) => {
      if (frame.kind === "refusal") custody.receiveRefusal(frame.wire);
      else if (frame.kind === "session" && frame.frame.kind === "receipt")
        custody.receive(frame.frame.wire);
      else return false;
      return true;
    },
  };
}
