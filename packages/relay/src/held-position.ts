import type { createHoldback } from "@syncmesh/transport";

/**
 * The furthest offset a session's frames have carried, said only once the holdback keeps nothing
 * back. Behind the fold chain alone is not enough: an event folded into the holdback was sent but
 * is not a row yet, and a wanted event that a burst puts ahead of its author's pass-over is
 * exactly that until the pass-over lands (D24).
 */
export const heldPosition = (
  holdback: ReturnType<typeof createHoldback>,
  say: ((offset: number) => void) | undefined,
) => {
  let unsaid: number | undefined;
  return {
    /** A frame carried `offset`, and everything sent below it has been through the fold chain. */
    reached: (offset: number): void => {
      if (unsaid === undefined || offset > unsaid) unsaid = offset;
    },
    /** Says what was reached, once the holdback has let go of every event it was handed. */
    flush: (): void => {
      if (unsaid === undefined || !holdback.empty()) return;
      const offset = unsaid;
      unsaid = undefined;
      say?.(offset);
    },
  };
};
