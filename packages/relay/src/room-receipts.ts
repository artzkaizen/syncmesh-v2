import type { Cursors } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { Identity } from "@syncmesh/wire";

import { Temporal, durationMs } from "@syncmesh/temporal";
import { receiptFrame } from "@syncmesh/transport";
import { issueReceipt } from "@syncmesh/wire";

import type { RelayRetention } from "./retention.js";
import type { RoomState } from "./state.js";

/** How the room signs its own custody (D28, U38). */
export interface RoomCustodyOptions {
  /**
   * The longest a seated author waits for the room's receipt after one of its writes lands. Every
   * write of one author inside this window is one signature: the room signs the run it holds, not
   * each event. Default {@link ROOM_CUSTODY_EVERY}.
   */
  readonly every?: Temporal.Duration;
}

/** How long writes are gathered before the room signs for them, when `every` is not given. */
export const ROOM_CUSTODY_EVERY = Temporal.Duration.from({ seconds: 1 });

/**
 * Throws when a room given `custody` could not sign it truthfully — a definition mistake. A
 * receipt licenses a deletion on its author's device, so it must stay true for as long as the key
 * names it: the key has to be given and outlive the log (one minted per process, or kept beside
 * the log, comes back as a different holder after the log is lost, and what the old key signed is
 * never withdrawn), the log has to be durable, and it must not be trimmed, because a receipt says
 * "everything through N". A log trimmed before this open is not refused: the room's held run starts
 * empty under its floors, so an author it trimmed is never signed for and the others still are.
 *
 * @param who - What is asking, for the message: a room by name, or a host.
 */
export function assertTruthfulCustody(
  custody: RoomCustodyOptions | undefined,
  room: {
    readonly identity?: Identity | undefined;
    readonly durable?: boolean | undefined;
    readonly retention?: Pick<RelayRetention, "keepEventsFor"> | undefined;
  },
  who: string,
): void {
  if (custody === undefined) return;
  const why =
    room.identity === undefined
      ? "it has no configured key (`identity`) that outlives its log"
      : room.durable !== true
        ? "its log is not durable"
        : room.retention?.keepEventsFor !== undefined
          ? "it trims its log (`retention.keepEventsFor`)"
          : undefined;
  if (why !== undefined) throw new Error(`${who} cannot sign custody: ${why}`);
}

/**
 * What a host passes to one room it opens: its `custody`, or nothing when the room cannot sign
 * truthfully under the host's key — a log that is not durable, or a store that brings its own key,
 * which is lost with the log (a Durable Object's). A room asked to sign that will not is said at
 * each open, so an operator does not believe it signs.
 */
export function hostedCustody(
  custody: RoomCustodyOptions | undefined,
  held: { readonly durable?: boolean | undefined; readonly identity?: Identity | undefined },
  name: string,
): RoomCustodyOptions | undefined {
  if (custody === undefined || (held.durable === true && held.identity === undefined))
    return custody;
  const why =
    held.identity === undefined
      ? "its log is not durable"
      : "its store brings its own key, which is lost with the log";
  console.warn(`syncmesh relay: room ${name} signs no custody — ${why} (U38)`);
  return undefined;
}

/**
 * The room's own custody receipts (D28's incarnation tier, U38): what it holds of each author,
 * signed under the room's key with its epoch as the incarnation, and handed to that author alone.
 */
export interface RoomReceipts {
  /**
   * `author` sat down here: what the room holds of its writes is signed to it now, whatever was
   * signed to an earlier seating, because a receipt sent while it was away reached nobody.
   */
  readonly seated: (author: PeerId) => void;
  /** An entry of `author` landed in the log: signed to it within `every`, with the others beside it. */
  readonly appended: (author: PeerId) => void;
  readonly close: () => void;
}

/**
 * Signs the room's run of each author's writes to that author: one receipt per author per
 * `every` while it writes, one when it sits down, and none when the run has not moved since the
 * last one this seating was sent.
 *
 * The run is the room's held run: every event of the author's from its first through N is in the
 * log. It is the contiguous cursor every `hello` advertises, except for an author whose events
 * compaction removed before this open — advertised, so nobody is sent them again, but not held, so
 * never signed. The incarnation is the epoch, so
 * a log the room lost and started again is a new lineage, and the author's ledger stops counting
 * what the room signed out of the old one as soon as it hears from the new one (D28 §2).
 *
 * @example
 * const receipts = createRoomReceipts(state, { every: Temporal.Duration.from({ seconds: 1 }) });
 * receipts.appended(author); // within a second, the author's socket is sent one receipt
 */
export function createRoomReceipts(
  room: Pick<RoomState, "clients" | "identity" | "epoch" | "now"> & {
    /** Per author, the run the log holds from its first event with no hole (`heldRuns`). */
    readonly held: () => Cursors;
  },
  options: RoomCustodyOptions = {},
): RoomReceipts {
  const every = options.every ?? ROOM_CUSTODY_EVERY;
  // per author, the run last signed to the seating it is in now: one entry per author that ever
  // sat down here, kept for the room's life, as the room's coverage keeps one per author anyway
  const signed = new Map<PeerId, SeqNum>();
  const waiting = new Set<PeerId>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sign = (author: PeerId): void => {
    const client = room.clients.get(author);
    const through = room.held().get(author);
    if (client === undefined || through === undefined || signed.get(author) === through) return;
    const wire = issueReceipt(room.identity, {
      author,
      throughSeq: through,
      incarnation: room.epoch,
      now: room.now(),
    });
    client.sender.send(receiptFrame(wire));
    signed.set(author, through);
  };

  const flush = (): void => {
    timer = undefined;
    for (const author of waiting) sign(author);
    waiting.clear();
  };

  return {
    seated: (author) => {
      signed.delete(author);
      sign(author);
    },
    appended: (author) => {
      waiting.add(author);
      timer ??= setTimeout(flush, durationMs(every));
    },
    close: () => {
      clearTimeout(timer);
      timer = undefined;
      waiting.clear();
    },
  };
}
