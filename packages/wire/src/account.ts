import type { AccountId, PartitionKey, PeerId } from "@syncmesh/kernel";

import { parseAccountId, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import { decodeCbor, type MalformedCbor } from "./cbor-decode.js";
import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { encodeCbor, type CborKey, type CborValue } from "./cbor.js";
import { MalformedEnvelope, splitEnvelope } from "./envelope.js";
import { bytesToHex, hexToBytes } from "./hex.js";
import { verify, type Identity } from "./identity.js";

/**
 * What a link says: this account claims this device, in this instance, from then. See D21.
 *
 * A link is a *mutual* claim, and unilateral either way is an attack — an account alone could
 * bind a stranger's device, a device alone could claim any account. This core carries one half:
 * the account signs it. The other half is free, because the event that carries the link is
 * already signed by its author, so `event.peerId === core.device` is the device's signature.
 */
export interface AccountCore {
  readonly v: 1;
  readonly op: "link" | "unlink";
  /** The account's Ed25519 public key as hex — the id **is** the verifier this core names. */
  readonly account: AccountId;
  readonly device: PeerId;
  /**
   * Which instance the claim holds in. Inside the signed core, or a device replays its
   * `org:acme` link into `org:victim`; and a device that is Alice's here may mean nothing there.
   */
  readonly partition: PartitionKey;
  readonly at: Temporal.Instant;
}

/** Link core map keys, frozen by the account vectors. `6` is reserved for a future `label` (D21). */
const KEY = { v: 0, account: 1, device: 2, op: 3, partition: 4, at: 5 } as const;

/** The verb as a small int: one byte on the wire rather than the seven a text `unlink` costs. */
const OP = { link: 0, unlink: 1 } as const;

export class MalformedLink extends TaggedError("MalformedLink")<{ message: string }> {}
export class BadLinkSignature extends TaggedError("BadLinkSignature")<{ message: string }> {}

export type LinkError = MalformedCbor | MalformedLink | BadLinkSignature;

/** The signed bytes of a link core, canonical and with no optional keys — every link is six pairs. */
export function encodeAccountCore(core: AccountCore): Uint8Array {
  return encodeCbor(
    new Map<CborKey, CborValue>([
      [KEY.v, core.v],
      [KEY.account, hexToBytes(core.account).unwrap()],
      [KEY.device, hexToBytes(core.device).unwrap()],
      [KEY.op, OP[core.op]],
      [KEY.partition, core.partition],
      [KEY.at, core.at.epochMilliseconds],
    ]),
  );
}

/**
 * Signs a link core with the account's own key, as wire bytes `[core, sig]` — the same envelope
 * events and grants use.
 *
 * `account` must be the keypair `core.account` names, since that hex *is* the public key
 * {@link verifyLink} checks against; signing with any other key mints bytes nobody will accept.
 *
 * ```ts
 * const wire = signLink(alice, { v: 1, op: "link", account: alice.peerId, device, partition, at })
 * ```
 */
export function signLink(account: Identity, core: AccountCore): Uint8Array {
  const bytes = encodeAccountCore(core);
  return encodeCbor([bytes, account.sign(bytes)]);
}

/**
 * Decodes a link and checks its signature against the received core bytes. Never throws.
 *
 * **It takes no issuer**: the core names its own verifier, because the account id is the public
 * key. Nothing configured has to be consulted to know who should have signed this.
 *
 * **It takes no clock, and there is deliberately no `LinkExpired`.** Expiry is a staleness bound
 * on a *capability*; a link is a label, and a label does not lapse. `unlink` is the only verb
 * that ends one — which is also why a validator with no clock can judge a link at all.
 */
export function verifyLink(wire: Uint8Array): Result<AccountCore, LinkError> {
  return Result.gen(function* () {
    const { core, sig } = yield* splitLink(wire);
    const link = yield* decodeCbor(core).andThen(decodeAccountValue);
    if (!verify(core, sig, hexToBytes(link.account).unwrap())) {
      return Result.err(
        new BadLinkSignature({
          message: "signature does not cover the received core, or is not the account's",
        }),
      );
    }
    return Result.ok(link);
  });
}

const malformed = (message: string) => Result.err(new MalformedLink({ message }));

/** The shared envelope split, reported in this module's vocabulary so `LinkError` stays closed. */
const splitLink = (wire: Uint8Array) =>
  splitEnvelope(wire).mapError((error) =>
    error instanceof MalformedEnvelope ? new MalformedLink({ message: error.message }) : error,
  );

/** An id that will not parse is a malformed core, not a second failure the caller must handle. */
const asMalformed = (error: { readonly message: string }) =>
  new MalformedLink({ message: error.message });

const isVerb = (v: CborValue | undefined): v is 0 | 1 => v === OP.link || v === OP.unlink;

function decodeAccountValue(value: CborValue): Result<AccountCore, MalformedLink> {
  if (!(value instanceof Map)) return malformed("core is not a map");
  if (value.get(KEY.v) !== 1) return malformed("unsupported version");
  const account = value.get(KEY.account);
  const device = value.get(KEY.device);
  const op = value.get(KEY.op);
  const partition = value.get(KEY.partition);
  const at = value.get(KEY.at);
  if (!(account instanceof Uint8Array)) return malformed("account is not bytes");
  if (!(device instanceof Uint8Array)) return malformed("device is not bytes");
  if (!isVerb(op)) return malformed("op is not link or unlink");
  if (!isString(partition)) return malformed("partition is not text");
  if (!isSafeNonNegative(at)) return malformed("at is not epoch ms");
  return Result.gen(function* () {
    const id = yield* parseAccountId(bytesToHex(account)).mapError(asMalformed);
    const peer = yield* parsePeerId(bytesToHex(device)).mapError(asMalformed);
    const key = yield* parsePartitionKey(partition).mapError(asMalformed);
    return Result.ok({
      v: 1,
      op: op === OP.link ? "link" : "unlink",
      account: id,
      device: peer,
      partition: key,
      at: Temporal.Instant.fromEpochMilliseconds(at),
    } satisfies AccountCore);
  });
}
