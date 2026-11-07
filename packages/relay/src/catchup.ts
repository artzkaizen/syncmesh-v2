import type { Coverage, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum, SyncEvent } from "@syncmesh/kernel";

import { timed, trackCoverage } from "@syncmesh/engine";
import { relayEnvelope } from "@syncmesh/wire";

import type { Conversation } from "./state.js";

import { pageFrame } from "./frames.js";
import { BELOW_FLOOR, belowFloor } from "./retention.js";

/**
 * What a filtered catch-up hands over at its end (D23): per author, how far the *unfiltered* run
 * ran contiguously above where the joiner asked from.
 *
 * Computed over what was scanned rather than over what was sent, because that is the only number
 * that answers the joiner's real question. Its own fold stops at the first sequence the filter
 * dropped, and nothing will ever fill that hole — the relay is declining to on purpose — so
 * without this the cursor pins there and the holdback stalls behind it forever.
 *
 * Contiguity is measured with the joiner's own tracker, so relay and client apply one rule and
 * cannot disagree about it. Two relays holding the same events answer the same number, which is
 * what stops a scoped cursor depending on which relay happened to serve it.
 */
function scannedCoverage(
  entries: readonly StoredEvent[],
  theirs: ReadonlyMap<PeerId, SeqNum>,
  scope: string,
): Coverage {
  const tracker = trackCoverage({ synced: new Map(theirs), local: new Map() });
  for (const entry of entries) tracker.note(entry.event);
  return { ...tracker.current(), scope };
}

/** What a catch-up needs of the socket it serves: what it may send, and what that slice is called. */
export interface CatchUpViewer {
  /** Asks the authority what this socket may read (D24); `false` when the join was refused for it. */
  readonly entitle: () => Promise<boolean>;
  /** The live filter, asked of history: the interest, then the gate. */
  readonly wants: (event: SyncEvent) => boolean;
  /** The slice the scan is true for — interest and entitlement — or `undefined` when nothing was filtered. */
  readonly scope: () => string | undefined;
  /** The pages are on the socket: from here a pass-over can no longer outrun them. */
  readonly paged: () => void;
}

/**
 * A catch-up's frames, and what did not make it into one.
 *
 * The second number exists because the first cannot carry it. A page is bytes; an entry the
 * relay could not build bytes for leaves no trace in a page, in the page count, or in the
 * admitted count that was taken before the envelopes were built — so without this, serving a
 * joiner a run with a hole in it and serving it a whole run produce identical reports.
 */
export interface Paged {
  readonly pages: readonly Uint8Array[];
  /** Entries that can never leave this relay: no signature was stored, and nobody here can make one. */
  readonly unsendable: number;
}

/**
 * A joiner's history as frames: `pageSize` events each, grants on the first, and always at least
 * one page — its `more: false` is what releases the client's push-outstanding, so a client that
 * is already caught up still gets told so. One frame is not a transfer, it is a cliff (RFC-0010).
 *
 * The scoped coverage rides the last page rather than a frame of its own: it is only true once
 * every page before it has landed, and a separate frame could be applied when it was not.
 *
 * **An entry with no envelope is counted, not merely skipped.** The room already keeps such an
 * entry out of the cursors it advertises, so no joiner is told to stand above a hole — but
 * "correctly advertised" and "silently short" are the same wire, and only one of them is a
 * thing an operator can be told about. See {@link Paged.unsendable}.
 */
export function paged(
  entries: readonly StoredEvent[],
  grantWires: readonly Uint8Array[],
  pageSize: number,
  offset: number,
  scoped?: Coverage,
): Paged {
  const wires = entries.map(relayEnvelope).filter((w): w is Uint8Array => w !== undefined);
  const pages: Uint8Array[] = [];
  let index = 0;
  do {
    const slice = wires.slice(index, index + pageSize);
    index += pageSize;
    const grantsForPage = index <= pageSize ? [...grantWires] : [];
    const more = index < wires.length;
    pages.push(pageFrame(grantsForPage, slice, more, offset, more ? undefined : scoped));
  } while (index < wires.length);
  return { pages, unsendable: entries.length - wires.length };
}

/**
 * The catch-up half of a join, on the room's queue so its offset cannot move under it. The
 * interest arrives by value rather than read back from the socket: a second join landing while
 * this one is queued must not retarget the pages the first one asked for.
 *
 * The floor is checked here and not only at the join, because a retention sweep runs on this same
 * queue and only moves the floor when it resolves. A join that lands while one is in flight reads
 * the floor from before it, is greeted, and would then be paged the run the sweep had just taken
 * the bottom out of. Asked again at the head of the queue, the sweep has either finished or has
 * not started, and there is no third state.
 */
export function sendCatchUp(
  conversation: Conversation,
  theirs: ReadonlyMap<PeerId, SeqNum>,
  viewer: CatchUpViewer,
): void {
  const { room, sender, refuse } = conversation;
  room.enqueue(async () => {
    if (belowFloor(theirs, room.floor())) {
      refuse("retention", BELOW_FLOOR, true);
      return;
    }
    // on the queue and ahead of the scan, so nothing is appended between the answer and the run
    // it is applied to — an event withheld live before the answer is in this scan
    if (!(await viewer.entitle())) return;
    const [sizes, duration] = await timed(async () => {
      const entries = await room.store.allSince(theirs);
      if (entries.isErr()) {
        refuse("store", entries.error.message);
        return undefined;
      }
      const found = entries.value;
      // narrowed at the sender: an event this device did not ask for, or was not admitted to,
      // never becomes a page
      const scope = viewer.scope();
      const admitted =
        scope === undefined ? found : found.filter((entry) => viewer.wants(entry.event));
      // and said so, naming the entitlement as well as the interest (D24)
      const scoped = scope === undefined ? undefined : scannedCoverage(found, theirs, scope);
      const { pages, unsendable } = paged(
        admitted,
        room.grants.all(),
        room.pageSize,
        room.offset(),
        scoped,
      );
      for (const page of pages) sender.send(page);
      viewer.paged();
      return { found: found.length, admitted: admitted.length, unsendable, pages: pages.length };
    });
    if (sizes !== undefined) room.report({ type: "relay.catchup", sizes, duration });
  });
}
