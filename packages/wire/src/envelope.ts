import type { SyncEvent } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { EventCrypto } from "./sealing.js";

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

/**
 * An event beside the core bytes a signature covers, where this build ever held them — what a log
 * keeps for one event and what a forwarder sends.
 *
 * `core` is not a re-encode. {@link decodeEventCore} ignores map keys this build has no name for,
 * so `encodeEventCore` of a decoded event is shorter than the bytes a newer peer signed, and a
 * signature beside it covers nothing that leaves. Keeping the arrival bytes is what lets D13's
 * additive rule survive a relay hop.
 *
 * Both are absent together on an event this device authored and has not signed yet: `mutate`
 * appends before any link exists to sign for it, and {@link signEvent} produces the pair when it
 * does. A `sig` standing alone is what {@link relayEnvelope} has to fall back on.
 *
 * A `core` can also stand alone, for an event taken from a feed chunk: a run carries the cores it
 * is chained over and one certificate instead of one signature each, so the engine keeps the bytes
 * and has no per-event signature to keep beside them. Such an entry is never forwarded — there is
 * nothing to forward — and `chunkSince` serves it on as part of a run instead.
 */
export interface SignedEvent {
  readonly event: SyncEvent;
  readonly core?: Uint8Array | undefined;
  readonly sig?: Uint8Array | undefined;
}

/** A {@link SignedEvent} that has been verified: both halves present, and the envelope they came in. */
export interface VerifiedEvent extends SignedEvent {
  readonly event: SyncEvent;
  readonly wire: Uint8Array;
  readonly core: Uint8Array;
  readonly sig: Uint8Array;
}

export function signEvent(
  event: SyncEvent,
  identity: Identity,
  crypto?: EventCrypto,
): VerifiedEvent {
  const core = encodeEventCore(event, crypto);
  const sig = identity.sign(core);
  return { event, core, sig, wire: encodeCbor([core, sig]) };
}

/** `[core, sig]` → the event, only if the signature covers the received core bytes. Never throws. */
export function decodeAndVerify(
  wire: Uint8Array,
  crypto?: EventCrypto,
): Result<VerifiedEvent, WireError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitEnvelope(wire);
    const event = yield* decodeEventCore(core, crypto);
    const publicKey = hexToBytes(event.peerId).unwrap();
    if (!verify(core, sig, publicKey))
      return Result.err(
        new BadSignature({ message: "signature does not cover the received core" }),
      );
    return Result.ok({ event, wire, core, sig });
  });
}

/**
 * A held event as `[core, sig]` bytes to forward, or `undefined` when no signature was ever held
 * for it — nobody but the author can sign it, so there is nothing to send.
 *
 * The held `core` goes out verbatim: re-encoding the decoded event drops the map keys this build
 * ignored on the way in, and the author's signature then covers bytes nobody sent.
 *
 * An entry with a signature and no core is re-encoded, which is exactly the loss above — stated
 * rather than silent. Neither store here produces one, because both hand a core back for every
 * row; what a row written *before* the log kept arrival bytes holds under that column is already
 * a re-encode, so it relays as it always did and the far side refuses it whenever the decoder
 * dropped something.
 *
 * Nothing rewrites such a row. The log's insert is idempotent by event id and a re-arrival never
 * reaches the store, so what it holds is what it will hold; the event stays reachable from its
 * author by a peer that asks for it, and does not become reachable through this hop.
 */
export function relayEnvelope(entry: SignedEvent): Uint8Array | undefined {
  if (!isRelayable(entry)) return undefined;
  return encodeCbor([entry.core ?? encodeEventCore(entry.event), entry.sig]);
}

/**
 * Whether {@link relayEnvelope} can build bytes for this entry — the one place the rule "can
 * this ever leave this device" is written down.
 *
 * A signature is the whole of it. An entry without one is either this device's own write, which
 * `signEvent` re-signs on the way out and never relays, or an event authored by a key this device
 * does not hold — and no key here can make one. Callers that decide anything about reachability
 * ask this rather than re-testing `sig`, so a relay's advertised coverage, a forwarder's refusal
 * and a device's own audit of what it is stuck holding cannot disagree about the same row.
 */
export function isRelayable(entry: SignedEvent): entry is SignedEvent & { sig: Uint8Array } {
  return entry.sig !== undefined;
}
