import type { SyncEvent } from "@syncmesh/kernel";

import { decodeCbor } from "../cbor-decode.js";
import { encodeCbor, type CborKey, type CborValue } from "../cbor.js";
import { encodeEventCore } from "../event-codec.js";
import { type Identity } from "../identity.js";

/**
 * The one fixture every package needs to test D13's additive rule, declared here because every
 * package that needs it already depends on `@syncmesh/wire`: an event core carrying a field this
 * build has no name for, and the signature standing over those exact bytes.
 *
 * It is what a **newer build** puts on the wire. `decodeEventCore` drops the key in silence, so
 * `encodeEventCore` of what this build read is shorter than what the author signed — and anything
 * that re-encodes on the way back out sends bytes the signature does not cover. Five copies of
 * these four lines were drifting apart across four packages before this existed.
 */

/** Not one of the event core's frozen keys (RFC-0002), so `decodeEventCore` drops it in silence. */
export const FUTURE_KEY = 9;

/** What the added field says; only its presence matters, but a readable value makes a diff legible. */
export const FUTURE_VALUE = "a later build";

/** The bytes a core would have if one more field had been in the map when it was written. */
export function grownCore(core: Uint8Array): Uint8Array {
  const known = decodeCbor(core).unwrap();
  if (!(known instanceof Map)) throw new Error("an event core is a CBOR map");
  return encodeCbor(new Map<CborKey, CborValue>([...known, [FUTURE_KEY, FUTURE_VALUE]]));
}

/** The signed halves of that event: the grown core, its signature, and the envelope carrying both. */
export function fromALaterBuild(event: SyncEvent, identity: Identity) {
  const core = grownCore(encodeEventCore(event));
  const sig = identity.sign(core);
  return { core, sig, wire: encodeCbor([core, sig]) };
}
