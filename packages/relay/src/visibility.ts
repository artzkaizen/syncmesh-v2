import type { TransportVisibility, VisibilityToken } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { VisibilityLost, VisibilityTimeout } from "@syncmesh/transport";

/** How long `visibleAt` waits when the caller names no deadline (RFC-0020 §3.2). */
const DEFAULT_TIMEOUT = Temporal.Duration.from({ seconds: 10 });

type Settled = Result<void, VisibilityLost | VisibilityTimeout>;

interface Waiter {
  readonly token: VisibilityToken;
  readonly settle: (outcome: Settled) => void;
}

const lost = (expected: string, actual: string): Settled =>
  Result.err(
    new VisibilityLost({
      expected,
      actual,
      message: `the token names log ${expected}, and this device is reading log ${actual}`,
    }),
  );

/**
 * One relay link's answer to *can I read it back yet?* (RFC-0020 §3.2, N1b): the lineage the room
 * last said hello under, and the furthest offset any frame since has carried — each said only once
 * everything sent below it has been folded, so a settled wait is a row the app can read.
 *
 * A new lineage settles every waiter minted against another one as {@link VisibilityLost}, the
 * moment the hello that announces it arrives: the position they asked about is in a log this
 * device is no longer reading, and waiting longer would only turn a known answer into a timeout.
 */
export function createVisibility() {
  let told: VisibilityToken | undefined;
  const waiters = new Set<Waiter>();

  const answer = (token: VisibilityToken): Settled | undefined => {
    if (told === undefined) return undefined;
    if (told.epoch !== token.epoch) return lost(token.epoch, told.epoch);
    return told.offset >= token.offset ? Result.ok(undefined) : undefined;
  };

  const sweep = (): void => {
    for (const waiter of waiters) {
      const outcome = answer(waiter.token);
      if (outcome !== undefined) waiter.settle(outcome);
    }
  };

  const capability: TransportVisibility = {
    token: () => told,
    visibleAt: (token, options = {}) => {
      const now = answer(token);
      if (now !== undefined) return Promise.resolve(now);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT.total("milliseconds");
      return new Promise<Settled>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(
            Result.err(
              new VisibilityTimeout({
                offset: token.offset,
                message: `offset ${token.offset} was not reached within ${timeoutMs}ms`,
              }),
            ),
          );
        }, timeoutMs);
        const waiter: Waiter = {
          token,
          settle: (outcome) => {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve(outcome);
          },
        };
        waiters.add(waiter);
      });
    },
  };

  return {
    capability,
    /** The room said hello under `epoch`: the same log keeps its offset, another one starts at none. */
    lineage: (epoch: string): void => {
      if (told?.epoch !== epoch) told = { epoch, offset: 0 };
      sweep();
    },
    /** A frame carried `offset`, and everything below it has been folded. */
    reached: (offset: number): void => {
      if (told === undefined || offset <= told.offset) return;
      told = { epoch: told.epoch, offset };
      sweep();
    },
  };
}
