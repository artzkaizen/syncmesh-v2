import type { LinkEvent } from "@syncmesh/transport";

import type { DevtoolsEndingTally, DevtoolsLinkEvent } from "../contract.js";

/**
 * The one history this source keeps, and the reason it keeps exactly one.
 *
 * Every other fact a panel reads is a snapshot it can take again — coverage, acks, grants, the
 * route table. Link endings are not: `onLinkEvent` retains nothing by design, so a device that
 * was refused six times in the last minute has nothing at all to show for it unless somebody held
 * on to the six. That is the difference between a panel that says *this radio is fine* and one
 * that answers *why does this peer keep dropping*, which is the question a person opens a devtool
 * with.
 *
 * A fixed ring rather than a growing list, because the alternative is a devtool left open
 * overnight that costs the app its memory. The oldest ending goes without ceremony: a refusal
 * from an hour ago has already been read or has already stopped mattering.
 */

/** Enough to cover a reconnect storm and read the shape of it; few enough to forget about. */
export const LINK_HISTORY = 200;

export interface LinkRing {
  /** Records one ending. Stores the event as it arrived; nothing is projected until it is read. */
  readonly note: (event: LinkEvent) => void;
  /** Newest first, which is the order an endings list is read in. */
  readonly recent: () => readonly DevtoolsLinkEvent[];
  /**
   * The same endings counted by medium and kind, busiest first.
   *
   * Here rather than in each panel that wants it: the walk is identical every time, the ring is
   * short enough that walking it twice would still be free, and a count computed in one place
   * cannot be the one that quietly disagrees with the list beside it.
   */
  readonly tally: () => readonly DevtoolsEndingTally[];
}

/** Plain data, taken at read time: `LinkEvent`'s optional `peer` and `why` become explicit absences. */
const projected = (event: LinkEvent, id: number): DevtoolsLinkEvent => ({
  id,
  kind: event.kind,
  transport: event.transport,
  peer: event.peer,
  why: event.why,
  at: event.at,
});

export function createLinkRing(keep: number = LINK_HISTORY): LinkRing {
  const size = Math.max(1, Math.floor(keep));
  const held: (LinkEvent | undefined)[] = Array.from({ length: size });
  /** Where the next ending goes, and therefore where the oldest one currently is. */
  let at = 0;
  /**
   * How many endings have ever been noted, which doubles as the id of the next one.
   *
   * Ring position cannot be an identity: the same slot holds a different ending a minute later,
   * so a row keyed by it would silently become another row under a reader who had not scrolled.
   */
  let seen = 0;

  /** Newest first, and each ending's ordinal derived from where it sits behind the write head. */
  const walk = (): readonly DevtoolsLinkEvent[] => {
    const count = Math.min(seen, size);
    const out: DevtoolsLinkEvent[] = [];
    for (let step = 1; step <= count; step += 1) {
      const event = held[(at - step + size) % size];
      if (event !== undefined) out.push(projected(event, seen - step));
    }
    return out;
  };

  return {
    note: (event) => {
      held[at] = event;
      at = (at + 1) % size;
      seen += 1;
    },
    recent: walk,
    tally: () => {
      const counts = new Map<string, DevtoolsEndingTally>();
      for (const ending of walk()) {
        const key = `${ending.transport}\u0000${ending.kind}`;
        const held = counts.get(key);
        counts.set(
          key,
          held === undefined
            ? { transport: ending.transport, kind: ending.kind, count: 1 }
            : { ...held, count: held.count + 1 },
        );
      }
      return [...counts.values()].sort(
        (left, right) =>
          right.count - left.count ||
          (left.transport === right.transport
            ? left.kind.localeCompare(right.kind)
            : left.transport.localeCompare(right.transport)),
      );
    },
  };
}
