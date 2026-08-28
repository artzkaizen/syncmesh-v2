import type { Interest, StoredEvent } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { matchesInterest, timed } from "@syncmesh/engine";
import { encodeCbor, encodeEventCore } from "@syncmesh/wire";

import type { Conversation } from "./state.js";

import { pageFrame } from "./frames.js";

/** A stored event back to wire form; `undefined` for an entry whose signature was never stored. */
const envelopeOf = (entry: StoredEvent): Uint8Array | undefined =>
  entry.sig === undefined ? undefined : encodeCbor([encodeEventCore(entry.event), entry.sig]);

/**
 * A joiner's history as frames: `pageSize` events each, grants on the first, and always at least
 * one page — its `more: false` is what releases the client's push-outstanding, so a client that
 * is already caught up still gets told so. One frame is not a transfer, it is a cliff (RFC-0010).
 */
export function paged(
  entries: readonly StoredEvent[],
  grantWires: readonly Uint8Array[],
  pageSize: number,
  offset: number,
): readonly Uint8Array[] {
  const wires = entries.map(envelopeOf).filter((w): w is Uint8Array => w !== undefined);
  const pages: Uint8Array[] = [];
  let index = 0;
  do {
    const slice = wires.slice(index, index + pageSize);
    index += pageSize;
    const grantsForPage = index <= pageSize ? [...grantWires] : [];
    pages.push(pageFrame(grantsForPage, slice, index < wires.length, offset));
  } while (index < wires.length);
  return pages;
}

/**
 * The catch-up half of a join, on the room's queue so its offset cannot move under it. The
 * interest arrives by value rather than read back from the socket: a second join landing while
 * this one is queued must not retarget the pages the first one asked for.
 */
export function sendCatchUp(
  conversation: Conversation,
  theirs: ReadonlyMap<PeerId, SeqNum>,
  interest: Interest | undefined,
): void {
  const { room, sender, refuse } = conversation;
  room.enqueue(async () => {
    const [sizes, duration] = await timed(async () => {
      const entries = await room.store.allSince(theirs);
      if (entries.isErr()) {
        refuse("store", entries.error.message);
        return undefined;
      }
      const found = entries.value;
      // narrowed at the sender: an event this device did not ask for never becomes a page
      const admitted =
        interest === undefined
          ? found
          : found.filter((entry) => matchesInterest(interest, entry.event));
      const pages = paged(admitted, room.grants.all(), room.pageSize, room.offset());
      for (const page of pages) sender.send(page);
      return { found: found.length, admitted: admitted.length, pages: pages.length };
    });
    if (sizes !== undefined) room.report({ type: "relay.catchup", sizes, duration });
  });
}
