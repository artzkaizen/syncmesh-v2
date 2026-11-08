import type { PartitionKey } from "@syncmesh/kernel";
import type { BlobRefusal, TransportBlobs } from "@syncmesh/transport";

import { omitUndefined } from "@syncmesh/result";
import { Temporal, durationMs } from "@syncmesh/temporal";
import { BLOB_MISSING } from "@syncmesh/transport";

import type { RelayFrame } from "./frames.js";

import { blobGetFrame, blobPutFrame } from "./frames.js";
import { UNGRANTED } from "./trust.js";

/**
 * How long an upload waits for the relay to say it kept the bytes. A relay built before
 * `blob-stored` never says, so this is also how long a put against one takes — and running out
 * is not a refusal, because silence is what that relay has always answered with.
 */
export const BLOB_ANSWER_WAIT = Temporal.Duration.from({ seconds: 10 });

/** What a relay said about one download: the bytes, or that it holds none. */
type Answer = Uint8Array | typeof BLOB_MISSING;

/**
 * One request in flight: the frame that asks it, and the session it last left on — `undefined`
 * while it has not left on any. What lets a request outlive the socket it was sent on.
 */
interface Asked {
  readonly frame: Uint8Array;
  sentIn: number | undefined;
}

/** One download waiting on its answer. */
interface Download extends Asked {
  readonly settle: (answer: Answer | undefined) => void;
}

/** One upload waiting on its answer, and the partition its bytes are billed to. */
interface Upload extends Asked {
  readonly partition: PartitionKey | undefined;
  readonly settle: (refusal: BlobRefusal | undefined) => void;
}

/**
 * The blob capability over one relay connection (D18): an upload offers bytes under their own
 * hash and waits for `blob-stored` or `blob-refused`; a download asks for them and waits for the
 * answer that names the same hash — the bytes, a `blob-missing`, or the deadline, whichever
 * arrives first.
 *
 * A request leaves only on a seated session — after the join, never before it — and one whose
 * session ended unanswered is sent again on the next seat. A socket the room closes to re-seat it
 * (a narrowed or widened grant, D40) drops what it was asked last, and the answer to that is the
 * room's under the new seat, not a deadline.
 *
 * `capability` is the object the transport hands the mesh, typed as the seam so it can grow with
 * it; `answer` and `settle` stay here, because an inbound frame settling a wait is the relay's
 * business.
 */
export function createBlobChannel(send: (frame: Uint8Array) => boolean) {
  /**
   * Downloads in flight, by hash: two fetches of one photo are two waits, and the first answer
   * that names the hash settles both.
   */
  const waiting = new Map<string, Download[]>();
  /**
   * Uploads in flight, by hash: two puts of one photo are two waits on one answer — unless the
   * answer is a refusal, which is about the budget of the one partition it names.
   */
  const uploading = new Map<string, Upload[]>();
  /** Counts the sessions this channel has been seated on; a request names the one it left on. */
  let session = 0;
  let seated = false;

  /** Sends the request now when a session is seated; otherwise the next seat sends it. */
  const offer = (asked: Asked): void => {
    if (seated && send(asked.frame)) asked.sentIn = session;
  };

  /** Keeps only the waits of this hash that `still` holds, and forgets the hash when none are left. */
  const keep = <W>(waits: Map<string, W[]>, hash: string, still: (wait: W) => boolean): void => {
    const rest = (waits.get(hash) ?? []).filter(still);
    if (rest.length === 0) waits.delete(hash);
    else waits.set(hash, rest);
  };

  const capability: TransportBlobs = {
    upload: (hash, bytes, options = {}) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          keep(uploading, hash, (upload) => upload !== mine);
          resolve(undefined);
        }, durationMs(BLOB_ANSWER_WAIT));
        const mine: Upload = {
          frame: blobPutFrame(hash, bytes, options.partition),
          sentIn: undefined,
          partition: options.partition,
          settle: (refusal) => {
            clearTimeout(timer);
            resolve(refusal);
          },
        };
        uploading.set(hash, [...(uploading.get(hash) ?? []), mine]);
        // the relay verifies before it stores
        offer(mine);
      }),
    download: (hash, { timeoutMs }) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          keep(waiting, hash, (download) => download !== mine);
          resolve(undefined);
        }, timeoutMs);
        const mine: Download = {
          frame: blobGetFrame(hash),
          sentIn: undefined,
          settle: (answer) => {
            clearTimeout(timer);
            resolve(answer);
          },
        };
        waiting.set(hash, [...(waiting.get(hash) ?? []), mine]);
        offer(mine);
      }),
  };
  return {
    capability,
    /**
     * A join went out: this session is seated, and every request still waiting that has not left
     * on it leaves now. A re-join on the same socket sends nothing twice.
     */
    seated: (): void => {
      seated = true;
      const pending: Asked[] = [...[...waiting.values()].flat(), ...[...uploading.values()].flat()];
      for (const asked of pending) if (asked.sentIn !== session) offer(asked);
    },
    /** The socket closed: what was asked on it and not answered goes again on the next seat. */
    unseated: (): void => {
      seated = false;
      session += 1;
    },
    /**
     * A `blob` or `blob-missing` arrived: the bytes, or `undefined` for none held there. It settles
     * every download of this hash, so the answer to a second fetch finds none left to settle.
     */
    answer: (hash: string, bytes: Uint8Array | undefined): void => {
      const downloads = waiting.get(hash) ?? [];
      waiting.delete(hash);
      for (const download of downloads) download.settle(bytes ?? BLOB_MISSING);
    },
    /**
     * A `blob-stored` (no refusal) arrived for every upload of this hash, or a `blob-refused` for
     * the uploads billed to the partition it names; the others wait on their own answer.
     */
    settle: (hash: string, refusal: BlobRefusal | undefined): void => {
      const answered = (upload: Upload): boolean =>
        refusal === undefined || upload.partition === refusal.partition;
      const waits = (uploading.get(hash) ?? []).filter(answered);
      keep(uploading, hash, (upload) => !answered(upload));
      for (const wait of waits) wait.settle(refusal);
    },
  };
}

/**
 * What a put's answer means to the upload waiting on it: nothing for `blob-stored`, the budget
 * for a `quota` refusal, the partition for an `ungranted` one (D44) — and nothing for any other
 * code, `no-store` from a room that keeps no blobs or one this build cannot name (D14), which is
 * what that upload heard before the answer existed.
 */
export const uploadRefusal = (
  frame: Extract<RelayFrame, { kind: "blob-stored" | "blob-refused" }>,
): BlobRefusal | undefined => {
  if (frame.kind !== "blob-refused") return undefined;
  if (frame.code === "quota")
    return omitUndefined({
      reason: "quota",
      limit: frame.limit,
      used: frame.used,
      partition: frame.partition,
    } as const);
  // a refusal naming no partition cannot be about a grant: a put billed to none is never refused
  if (frame.code === UNGRANTED && frame.partition !== undefined)
    return { reason: "ungranted", partition: frame.partition };
  return undefined;
};
