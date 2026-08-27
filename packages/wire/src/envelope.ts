import type { SyncEvent } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { encodeCbor } from "./cbor.js";
import { decodeEventCore, encodeEventCore, type MalformedEvent } from "./event-codec.js";
import { hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";

export class MalformedEnvelope extends TaggedError("MalformedEnvelope")<{ message: string }> {}

export class BadSignature extends TaggedError("BadSignature")<{ message: string }> {}

export type WireError = MalformedCbor | MalformedEnvelope | MalformedEvent | BadSignature;

/**
 * The `[core, sig]` envelope, split but unjudged — the one shape every signed thing on this wire
 * starts from: events, grants and account links alike. Splitting is not verifying; a caller that
 * decides anything from the core must go on to check the signature over these exact bytes.
 *
 * Readers with their own malformed error map {@link MalformedEnvelope} onto it, so that a second
 * copy of this decode does not reappear beside them.
 */
export function splitEnvelope(
  wire: Uint8Array,
): Result<
  { readonly core: Uint8Array; readonly sig: Uint8Array },
  MalformedCbor | MalformedEnvelope
> {
  return Result.gen(function* () {
    const outer = yield* decodeCbor(wire);
    if (!Array.isArray(outer) || outer.length !== 2)
      return Result.err(new MalformedEnvelope({ message: "expected [core, sig]" }));
    const [core, sig] = outer;
    if (!(core instanceof Uint8Array) || !(sig instanceof Uint8Array))
      return Result.err(new MalformedEnvelope({ message: "core and sig must be byte strings" }));
    return Result.ok({ core, sig });
  });
}

/** An event together with the exact bytes it was received as; forward `wire`, never re-encode. */
export interface VerifiedEvent {
  readonly event: SyncEvent;
  readonly wire: Uint8Array;
  readonly core: Uint8Array;
  readonly sig: Uint8Array;
}

export function signEvent(event: SyncEvent, identity: Identity): VerifiedEvent {
  const core = encodeEventCore(event);
  const sig = identity.sign(core);
  return { event, core, sig, wire: encodeCbor([core, sig]) };
}

/** `[core, sig]` → the event, only if the signature covers the received core bytes. Never throws. */
export function decodeAndVerify(wire: Uint8Array): Result<VerifiedEvent, WireError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitEnvelope(wire);
    const event = yield* decodeEventCore(core);
    const publicKey = hexToBytes(event.peerId).unwrap();
    if (!verify(core, sig, publicKey))
      return Result.err(
        new BadSignature({ message: "signature does not cover the received core" }),
      );
    return Result.ok({ event, wire, core, sig });
  });
}
