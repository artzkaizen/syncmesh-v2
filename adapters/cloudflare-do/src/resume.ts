import type { CborValue } from "@syncmesh/wire";

import { decodeCbor, encodeCbor } from "@syncmesh/wire";

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
 */
export interface Resume {
  /**
   * The challenge the room sent this socket (D33). Kept before the join is, because a socket
   * that sleeps between the two wakes to answer a challenge only the attachment still knows.
   */
  readonly nonce?: Uint8Array;
  readonly join?: Uint8Array;
  /** The grant frames this socket sent, oldest first; the oldest is what an over-long script drops. */
  readonly grants: readonly Uint8Array[];
}

/** What an attachment held: the challenge, if it was written, and the frames to replay. */
export interface Restored {
  readonly nonce: Uint8Array | undefined;
  readonly frames: readonly Uint8Array[];
}

/** The elements of a decoded script that are frames; anything else in there was never one. */
const framesOf = (decoded: readonly CborValue[]): readonly Uint8Array[] =>
  decoded.filter((element): element is Uint8Array => element instanceof Uint8Array);

/**
 * The script as attachment bytes, trimmed from the oldest grant until it fits. `undefined` when
 * even the bare `join` is too wide to keep — that socket wakes bound and silent, as it did before.
 */
export function encodeResume(resume: Resume): Uint8Array | undefined {
  // the challenge rides first, boxed, so a reader can tell it from a frame: every frame is bytes
  // and the box is an array, and a script written before challenges existed starts with bytes
  const head: CborValue = resume.nonce === undefined ? [] : [resume.nonce];
  const join = resume.join === undefined ? [] : [resume.join];
  for (let dropped = 0; dropped <= resume.grants.length; dropped += 1) {
    const bytes = encodeCbor([head, ...join, ...resume.grants.slice(dropped)]);
    if (bytes.byteLength <= ATTACHMENT_LIMIT) return bytes;
  }
  return undefined;
}

/** What the attachment kept: the challenge and the frames to replay, in the order first received. */
export function decodeResume(attachment: Uint8Array | null): Restored {
  if (attachment === null) return { nonce: undefined, frames: [] };
  const decoded = decodeCbor(attachment);
  if (decoded.isErr() || !Array.isArray(decoded.value)) return { nonce: undefined, frames: [] };
  const [head, ...rest] = decoded.value;
  if (!Array.isArray(head)) return { nonce: undefined, frames: framesOf(decoded.value) };
  const nonce = head[0] instanceof Uint8Array ? head[0] : undefined;
  return { nonce, frames: framesOf(rest) };
}

/**
 * The resume scripts of every socket this object holds, kept in step with what each one sent.
 * Memory, like everything else here: an eviction drops it, and the attachments it wrote are what
 * put it back.
 */
export function trackResume() {
  const scripts = new Map<DurableWebSocket, Resume>();

  const write = (ws: DurableWebSocket, next: Resume): void => {
    scripts.set(ws, next);
    const bytes = encodeResume(next);
    if (bytes !== undefined) ws.serializeAttachment(bytes);
  };

  /** The script as held, or an empty one for a socket nothing has been written about yet. */
  const held = (ws: DurableWebSocket): Resume => scripts.get(ws) ?? { grants: [] };

  return {
    /** The room challenged this socket; kept before anything else, so a sleep before the join loses nothing. */
    challenged: (ws: DurableWebSocket, nonce: Uint8Array): void => write(ws, { nonce, grants: [] }),
    /** A fresh join replaces the script whole: the grants of an older session are that session's. */
    joined: (ws: DurableWebSocket, join: Uint8Array): void => {
      const { nonce } = held(ws);
      write(ws, { ...(nonce !== undefined && { nonce }), join, grants: [] });
    },
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
      scripts.set(ws, {
        ...(kept.nonce !== undefined && { nonce: kept.nonce }),
        ...(join !== undefined && { join }),
        grants,
      });
    },
    forget: (ws: DurableWebSocket): void => void scripts.delete(ws),
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.every((byte, i) => byte === b[i]);
