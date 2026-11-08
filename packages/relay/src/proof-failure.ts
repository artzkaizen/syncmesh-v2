import type { RelayFrame } from "./frames.js";
import type { SecureLink } from "./secure.js";
import type { RoomState } from "./state.js";

import { verifyJoinProof } from "./proof.js";

/**
 * Why a join that names a key fails to prove it, or `undefined` when it passes. A wrong signature
 * fails on any version. A bare join — no sealed link, no proof — fails at v2, and in a grant-gated
 * room on any version (D40): the room seats it under the grant it caches for the key the join
 * names, so a key taken on trust would let anyone who has seen a device's public key read what
 * that device's grant names.
 */
export function proofFailure(
  frame: Extract<RelayFrame, { kind: "join" }>,
  selected: number,
  challenge: Uint8Array | undefined,
  link: SecureLink | undefined,
  room: RoomState,
): string | undefined {
  const proven =
    frame.proof === undefined || challenge === undefined
      ? undefined
      : verifyJoinProof(frame.peerId, challenge, frame.core, frame.proof);
  if (proven === false) return "the join was not signed by the key it names";
  if (link !== undefined || proven === true) return undefined;
  if (selected === 2) return "a v2 join signs the room's challenge with the key it names";
  if (room.trust !== undefined) return "a grant-gated room seats only a key the join proves";
  return undefined;
}
