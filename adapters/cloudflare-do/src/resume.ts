import type { LinkOffer, LinkSession } from "@syncmesh/relay";
import type { CborValue } from "@syncmesh/wire";

import { parsePeerId } from "@syncmesh/kernel";
import { omitUndefined } from "@syncmesh/result";
import {
  FIRST_EPOCH,
  bytesToHex,
  decodeCbor,
  encodeCbor,
  hexToBytes,
  openPayload,
  sealPayload,
} from "@syncmesh/wire";

import type { DurableWebSocket } from "./socket.js";

/** `serializeAttachment` refuses more than 16 KiB, and a throw here would reset the object. */
const ATTACHMENT_LIMIT = 16_000;

/**
 * What one socket has to be handed again for the room to be the room it was before an eviction.
 *
 * The `join` frame alone is not that. A device sends its grants immediately after joining and
 * never again, so a room rebuilt from joins has an empty grant cache — and the devices that
 * filled it never noticed the eviction and never rejoin. The next joiner is then paged a
 * catch-up with no grants on it and can validate none of the events it just received.
 *
 * Nor is the join enough for the link (D36). A socket that slept between the room's hello and
 * the device's answer has to finish the handshake with the secret it offered; one that slept
 * after it has to open the next sealed frame with the keys it agreed. Both are kept here, in
 * the head of the script, so a woken object can carry on the conversation where it stopped.
 */
export interface Resume {
  /** The challenge the room sent this socket (D33), on a room that challenges. */
  readonly nonce?: Uint8Array;
  /** The hello this socket was sent and the secret behind it, until the device's hello arrives (D36). */
  readonly offer?: LinkOffer;
  /** The link session, once agreed (D36); the offer is spent and no longer kept. */
  readonly session?: LinkSession;
  /** The join as the room read it — the plaintext, on a sealed link. */
  readonly join?: Uint8Array;
  /** The grant frames this socket sent, oldest first; the oldest is what an over-long script drops. */
  readonly grants: readonly Uint8Array[];
}

/** What an attachment held: the link's state, if any was written, and the frames to replay. */
export interface Restored {
  readonly nonce: Uint8Array | undefined;
  readonly offer: LinkOffer | undefined;
  readonly session: LinkSession | undefined;
  readonly frames: readonly Uint8Array[];
}

const NOTHING: Restored = { nonce: undefined, offer: undefined, session: undefined, frames: [] };

/** What the link secrets in an attachment are bound to, so they cannot be taken for anything else. */
const LINK_AAD = new TextEncoder().encode("syncmesh/do-link-secret/v1");

/**
 * The link secrets an attachment keeps (the offered secret, the session's two keys), sealed under
 * the object's attachment key (N26): the platform stores attachments at rest, and the bare keys
 * would open every frame of the session they belong to. The attachment key itself is sealed by the
 * host's vault in the object's SQLite (`relaySecret`).
 */
export interface LinkSealer {
  readonly seal: (secret: Uint8Array) => Uint8Array;
  /** `undefined` when the bytes do not open under this key: the socket wakes without that state. */
  readonly open: (sealed: Uint8Array) => Uint8Array | undefined;
}

/**
 * A {@link LinkSealer} over the object's 32-byte attachment key. `nonce` draws each seal's 24-byte
 * nonce; absent, a random one. Given only where the bytes must be the same every run (vectors).
 */
export const linkSealer = (key: Uint8Array, nonce?: () => Uint8Array): LinkSealer => ({
  seal: (secret) =>
    nonce === undefined
      ? sealPayload(key, secret, LINK_AAD)
      : sealPayload(key, secret, LINK_AAD, FIRST_EPOCH, nonce()),
  open: (sealed) => {
    const opened = openPayload(key, sealed, LINK_AAD);
    return opened.isOk() ? opened.value : undefined;
  },
});

/** A secret in the head: boxed as `[sealed]`, so a reader tells it from the bare bytes an earlier build wrote. */
const sealedSlot = (sealer: LinkSealer, secret: Uint8Array | undefined): CborValue =>
  secret === undefined ? null : [sealer.seal(secret)];

/** A secret back out of the head: opened when boxed, taken as it is when an earlier build left it bare. */
const secretAt = (
  sealer: LinkSealer,
  head: readonly CborValue[],
  at: number,
): Uint8Array | undefined => {
  const value = head[at];
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value)) return undefined;
  const [sealed] = value;
  return sealed instanceof Uint8Array ? sealer.open(sealed) : undefined;
};

/** The elements of a decoded script that are frames; anything else in there was never one. */
const framesOf = (decoded: readonly CborValue[]): readonly Uint8Array[] =>
  decoded.filter((element): element is Uint8Array => element instanceof Uint8Array);

/**
 * The head of the script, boxed so a reader can tell it from a frame — every frame is bytes and
 * the box is an array — with the link's state at fixed positions: the challenge, the offered
 * secret and hello, the two session keys and the peer they were agreed with. The secret and the
 * keys are sealed ({@link LinkSealer}). A position with nothing in it is `null`; trailing nulls
 * are not written, so a room that only challenges writes the head it always wrote.
 */
const headOf = (resume: Resume, sealer: LinkSealer): CborValue => {
  const slots: CborValue[] = [
    resume.nonce ?? null,
    sealedSlot(sealer, resume.offer?.secret),
    resume.offer?.hello ?? null,
    sealedSlot(sealer, resume.session?.keys.seal),
    sealedSlot(sealer, resume.session?.keys.open),
    resume.session === undefined ? null : hexToBytes(resume.session.peer).unwrap(),
  ];
  while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  return slots;
};

const bytesAt = (head: readonly CborValue[], at: number): Uint8Array | undefined => {
  const value = head[at];
  return value instanceof Uint8Array ? value : undefined;
};

/**
 * The script as attachment bytes, trimmed from the oldest grant until it fits. `undefined` when
 * even the bare `join` is too wide to keep — that socket wakes bound and silent, as it did before.
 */
export function encodeResume(resume: Resume, sealer: LinkSealer): Uint8Array | undefined {
  const head = headOf(resume, sealer);
  const join = resume.join === undefined ? [] : [resume.join];
  for (let dropped = 0; dropped <= resume.grants.length; dropped += 1) {
    const bytes = encodeCbor([head, ...join, ...resume.grants.slice(dropped)]);
    if (bytes.byteLength <= ATTACHMENT_LIMIT) return bytes;
  }
  return undefined;
}

/** What the attachment kept: the link's state and the frames to replay, in the order first received. */
export function decodeResume(attachment: Uint8Array | null, sealer: LinkSealer): Restored {
  if (attachment === null) return NOTHING;
  const decoded = decodeCbor(attachment);
  if (decoded.isErr() || !Array.isArray(decoded.value)) return NOTHING;
  const [head, ...rest] = decoded.value;
  // a script written before there was a head starts with a frame
  if (!Array.isArray(head)) return { ...NOTHING, frames: framesOf(decoded.value) };
  const nonce = bytesAt(head, 0);
  const secret = secretAt(sealer, head, 1);
  const hello = bytesAt(head, 2);
  const offer = secret !== undefined && hello !== undefined ? { secret, hello } : undefined;
  const seal = secretAt(sealer, head, 3);
  const open = secretAt(sealer, head, 4);
  const peer = bytesAt(head, 5);
  const parsed = peer === undefined ? undefined : parsePeerId(bytesToHex(peer));
  const session =
    seal !== undefined && open !== undefined && parsed?.isOk()
      ? { peer: parsed.value, keys: { seal, open } }
      : undefined;
  return { nonce, offer, session, frames: framesOf(rest) };
}

/**
 * The resume scripts of every socket this object holds, kept in step with what each one sent.
 * Memory, like everything else here: an eviction drops it, and the attachments it wrote are what
 * put it back.
 */
export function trackResume(sealer: () => LinkSealer) {
  const scripts = new Map<DurableWebSocket, Resume>();

  const write = (ws: DurableWebSocket, next: Resume): void => {
    scripts.set(ws, next);
    const bytes = encodeResume(next, sealer());
    if (bytes !== undefined) ws.serializeAttachment(bytes);
  };

  /** The script as held, or an empty one for a socket nothing has been written about yet. */
  const held = (ws: DurableWebSocket): Resume => scripts.get(ws) ?? { grants: [] };

  /** The link's half of a script — what a fresh join keeps and a fresh session replaces. */
  const linkOf = ({
    nonce,
    offer,
    session,
  }: {
    readonly nonce?: Uint8Array | undefined;
    readonly offer?: LinkOffer | undefined;
    readonly session?: LinkSession | undefined;
  }): Pick<Resume, "nonce" | "offer" | "session"> => omitUndefined({ nonce, offer, session });

  return {
    /** The room challenged this socket; kept before anything else, so a sleep before the join loses nothing. */
    challenged: (ws: DurableWebSocket, nonce: Uint8Array): void => write(ws, { nonce, grants: [] }),
    /** The room sent this socket its hello (D36); kept with the secret, so a sleep before the answer loses nothing. */
    offered: (ws: DurableWebSocket, offer: LinkOffer): void => write(ws, { offer, grants: [] }),
    /** The handshake completed: the session replaces the offer, which is spent. */
    secured: (ws: DurableWebSocket, session: LinkSession): void => {
      const { offer: _spent, ...rest } = held(ws);
      write(ws, { ...rest, session });
    },
    /** A fresh join replaces the script's frames whole: the grants of an older session are that session's. */
    joined: (ws: DurableWebSocket, join: Uint8Array): void =>
      write(ws, { ...linkOf(held(ws)), join, grants: [] }),
    /** One more grant on a socket that has joined; a repeat of one already held changes nothing. */
    granted: (ws: DurableWebSocket, grant: Uint8Array): void => {
      const held = scripts.get(ws);
      if (held === undefined) return;
      const seen = held.grants.some(
        (wire) => wire.length === grant.length && sameBytes(wire, grant),
      );
      if (!seen) write(ws, { ...held, grants: [...held.grants, grant] });
    },
    /** Reads what a woken socket kept, and takes it on as this instance's own. */
    restored: (ws: DurableWebSocket, kept: Restored): void => {
      const [join, ...grants] = kept.frames;
      scripts.set(ws, omitUndefined({ ...linkOf(kept), join, grants }));
    },
    forget: (ws: DurableWebSocket): void => void scripts.delete(ws),
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.every((byte, i) => byte === b[i]);
