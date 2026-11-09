import { describe, expect, jest, test } from "bun:test";

import type { RelayDial } from "../transport.js";

import { createRedial } from "../redial.js";

/**
 * The backoff on a clock the test drives. The room says hello before it refuses a join below its
 * floor, and the hello reset the backoff: a room that kept refusing was dialled on the first
 * delay every time, where it should be dialled on a delay that doubles (`retention.test.ts` has
 * the same over a real room, on the wall clock).
 */
describe("createRedial", () => {
  test("a refused join puts back the delay its hello reset, so each dial waits twice as long", async () => {
    jest.useFakeTimers();
    try {
      let dials = 0;
      const redial = createRedial({
        dial: () => {
          dials += 1;
          // never opens: the test reads only when each dial was asked for
          return new Promise<RelayDial>(() => undefined);
        },
        reconnectMs: 20,
        maxReconnectMs: 5000,
        done: () => false,
        onDialed: () => undefined,
        onFailed: () => undefined,
      });
      /** Milliseconds from now until the scheduled dial is asked for. */
      const nextDialAfter = async (): Promise<number> => {
        const before = dials;
        for (let ms = 1; ms <= 1000; ms += 1) {
          jest.advanceTimersByTime(1);
          await Promise.resolve();
          await Promise.resolve();
          if (dials > before) return ms;
        }
        return Number.POSITIVE_INFINITY;
      };
      const waits: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        // a session came up — the room's hello — and its join was refused; a write dials again
        redial.settled();
        redial.refused();
        redial.again();
        waits.push(await nextDialAfter());
      }
      expect(waits).toEqual([20, 40, 80]);
      redial.cancel();
    } finally {
      jest.useRealTimers();
    }
  });
});
