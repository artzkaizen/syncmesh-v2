import type { PeerId } from "@syncmesh/kernel";

import { verifyReceipt, verifyRefusal } from "@syncmesh/wire";

import type { RoomState } from "./state.js";

/**
 * The two signed facts about one author's write: a custody receipt (a session frame) and a
 * refusal (the relay's own `refusal` tag, D32), each the signed wire unchanged.
 */
export interface CustodyFrame {
  readonly kind: "receipt" | "refusal";
  readonly wire: Uint8Array;
}

/** Who signed a custody frame and whose write it is about, or `undefined` when it does not verify. */
const parties = (
  frame: CustodyFrame,
): { readonly signer: PeerId; readonly author: PeerId } | undefined => {
  if (frame.kind === "receipt") {
    const verified = verifyReceipt(frame.wire);
    return verified.isOk()
      ? { signer: verified.value.holder, author: verified.value.author }
      : undefined;
  }
  const verified = verifyRefusal(frame.wire);
  return verified.isOk()
    ? { signer: verified.value.refuser, author: verified.value.author }
    : undefined;
};

/**
 * Hands a receipt or a refusal to the author it is about, and to no other socket in the room.
 *
 * The frame bytes go on unchanged: the signature is the holder's or the refuser's, and the author
 * verifies it against the key the frame names, so the relay adds nothing a recipient must trust.
 * It verifies anyway, because forwarding junk would spend the author's socket on bytes it then
 * drops. `from` is the key the socket joined as: a socket speaks for itself, so a receipt signed by
 * anyone else is not passed on from it. A frame from another instance of the room (`fanIn`) has
 * no socket to hold it to, so it comes `from: "fleet"` and is checked by its signature alone.
 *
 * To the author only, rather than to the room as cursors go: a refusal names one peer's verdict
 * on one write, and nobody but that write's author has a use for it.
 *
 * @returns whether the frame verified, which is what decides that it is published to the fleet.
 */
export function routeCustody(
  room: Pick<RoomState, "clients">,
  bytes: Uint8Array,
  frame: CustodyFrame,
  from: PeerId | "fleet",
): boolean {
  const named = parties(frame);
  if (named === undefined) return false;
  if (from !== "fleet" && named.signer !== from) return false;
  room.clients.get(named.author)?.sender.send(bytes);
  return true;
}

/**
 * A custody frame from a seated socket: to its author here, and to the other instances of the
 * room when it verified. A socket not seated yet has no key to hold the frame to, and is ignored.
 */
export function forwardCustody(
  room: Pick<RoomState, "clients" | "publish">,
  bytes: Uint8Array,
  frame: CustodyFrame,
  from: PeerId | undefined,
): void {
  if (from !== undefined && routeCustody(room, bytes, frame, from)) room.publish(bytes);
}
