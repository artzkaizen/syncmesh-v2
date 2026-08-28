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
  readonly join: Uint8Array;
  /** The grant frames this socket sent, oldest first; the oldest is what an over-long script drops. */
  readonly grants: readonly Uint8Array[];
}

/** The elements of a decoded script that are frames; anything else in there was never one. */
const framesOf = (decoded: readonly CborValue[]): readonly Uint8Array[] =>
  decoded.filter((element): element is Uint8Array => element instanceof Uint8Array);

/**
 * The script as attachment bytes, trimmed from the oldest grant until it fits. `undefined` when
 * even the bare `join` is too wide to keep — that socket wakes bound and silent, as it did before.
 */
export function encodeResume(resume: Resume): Uint8Array | undefined {
  for (let dropped = 0; dropped <= resume.grants.length; dropped += 1) {
    const bytes = encodeCbor([resume.join, ...resume.grants.slice(dropped)]);
    if (bytes.byteLength <= ATTACHMENT_LIMIT) return bytes;
  }
  return undefined;
}

/** The frames to replay, in the order they were first received; empty for anything unreadable. */
export function decodeResume(attachment: Uint8Array | null): readonly Uint8Array[] {
  if (attachment === null) return [];
  const decoded = decodeCbor(attachment);
  if (decoded.isErr() || !Array.isArray(decoded.value)) return [];
  return framesOf(decoded.value);
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

  return {
    /** A fresh join replaces the script whole: the grants of an older session are that session's. */
    joined: (ws: DurableWebSocket, join: Uint8Array): void => write(ws, { join, grants: [] }),
    /** One more grant on a socket that has joined; a repeat of one already held changes nothing. */
    granted: (ws: DurableWebSocket, grant: Uint8Array): void => {
      const held = scripts.get(ws);
      if (held === undefined) return;
      const seen = held.grants.some(
        (wire) => wire.length === grant.length && sameBytes(wire, grant),
      );
      if (!seen) write(ws, { join: held.join, grants: [...held.grants, grant] });
    },
    /** Reads what a woken socket kept, and takes it on as this instance's own. */
    restored: (ws: DurableWebSocket, frames: readonly Uint8Array[]): void => {
      const [join, ...grants] = frames;
      if (join !== undefined) scripts.set(ws, { join, grants });
    },
    forget: (ws: DurableWebSocket): void => void scripts.delete(ws),
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.every((byte, i) => byte === b[i]);
