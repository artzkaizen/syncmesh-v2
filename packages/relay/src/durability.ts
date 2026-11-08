import type { Cursors } from "@syncmesh/engine";
import type { EventId, PeerId, SeqNum } from "@syncmesh/kernel";

import { trackCoverage } from "@syncmesh/engine";
import { parseEventId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { DurabilityLost } from "@syncmesh/transport";

/**
 * Per author, how many acks above a hole this link records before it stops recording more. Past
 * it, an ack is left for the next `hello` to cover: that hello carries what the room holds
 * contiguously, which is the same fact without the memory.
 */
export const MAX_ACKS_AHEAD = 1024;

type Held = Result<void, DurabilityLost>;

interface Waiter {
  readonly event: EventId;
  readonly peer: PeerId;
  readonly seq: SeqNum;
  /** The lineage the wait began under; `undefined` before this link has heard any hello. */
  epoch: string | undefined;
  readonly settle: (held: Held) => void;
}

/**
 * One relay link's answer to *does the room hold it, across a restart?* (D42): per author, the run
 * the room holds without a hole, from two sources that each say exactly that.
 *
 * - The `hello`. Its cursors are the room's contiguous coverage, so everything at or below them is
 *   in the log. This is also what settles a write whose ack was lost with its socket: the next
 *   session's hello covers it.
 * - Each `ack`. It names one event, recorded by id and never as "everything below it": a write
 *   made while an older backlog is still being pushed is acked first, and a newest-ack cursor
 *   would claim the backlog with it. An ack past a hole waits above it until the hole fills.
 *
 * Only a room whose hello says its log is durable is counted; a memory room's acks are dropped as
 * they arrive. A hello under a new epoch drops everything recorded — the old lineage's holdings
 * are not this log's, and every waiter that began under the old lineage settles as
 * {@link DurabilityLost} (decided 2026-11-08): an ack in the old log said nothing about the new one,
 * and a caller that wants the new log's answer asks again. A waiter that began before any hello
 * takes the first hello's lineage as its own.
 */
export function createDurability() {
  let epoch: string | undefined;
  let durable = false;
  let held = trackCoverage();
  const waiters = new Set<Waiter>();

  const holds = (peer: PeerId, seq: SeqNum, run: Cursors = held.current().synced): boolean =>
    durable && (run.get(peer) ?? 0) >= seq;

  const sweep = (): void => {
    const run = held.current().synced;
    for (const waiter of waiters)
      if (holds(waiter.peer, waiter.seq, run)) waiter.settle(Result.ok(undefined));
  };

  /** Settles every waiter that began under a lineage other than `now` as lost. */
  const replaced = (now: string): void => {
    for (const waiter of waiters) {
      waiter.epoch ??= now;
      if (waiter.epoch === now) continue;
      waiter.settle(
        Result.err(
          new DurabilityLost({
            event: waiter.event,
            expected: waiter.epoch,
            actual: now,
            message: `the room's log was replaced (epoch ${waiter.epoch} is now ${now}) before it held ${waiter.event}; ask again to wait on the new log`,
          }),
        ),
      );
    }
  };

  return {
    /**
     * Settles once a durable room holds the event, or as {@link DurabilityLost} when the room's log
     * is replaced first. A local id, which never travels, never settles.
     */
    durable: (event: EventId): Promise<Held> => {
      const parsed = parseEventId(event);
      if (parsed.isErr() || parsed.value.local) return new Promise(() => undefined);
      const { peerId: peer, seqNum: seq } = parsed.value;
      if (holds(peer, seq)) return Promise.resolve(Result.ok(undefined));
      return new Promise((resolve) => {
        const waiter: Waiter = {
          event,
          peer,
          seq,
          epoch,
          settle: (outcome) => {
            waiters.delete(waiter);
            resolve(outcome);
          },
        };
        waiters.add(waiter);
      });
    },
    /** The room said hello: its lineage, whether its log is durable, and what it holds unbroken. */
    hello: (said: string, saidDurable: boolean, cursors: Cursors): void => {
      if (said !== epoch || !saidDurable) held = trackCoverage();
      epoch = said;
      replaced(said);
      durable = saidDurable;
      if (!durable) return;
      held.adopt({ synced: cursors, local: new Map() });
      sweep();
    },
    /** The room acked one event by id; a duplicate is acked too, and counts the same. */
    acked: (id: string): void => {
      if (!durable) return;
      const parsed = parseEventId(id);
      if (parsed.isErr() || parsed.value.local) return;
      const { peerId, seqNum } = parsed.value;
      const contiguous = held.current().synced.get(peerId) ?? 0;
      if (seqNum <= contiguous) return;
      const ahead = held.ahead().get(peerId)?.length ?? 0;
      if (seqNum > contiguous + 1 && ahead >= MAX_ACKS_AHEAD) return;
      held.note({ peerId, seqNum });
      sweep();
    },
  };
}
