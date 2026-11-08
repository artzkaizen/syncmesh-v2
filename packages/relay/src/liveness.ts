import { durationMs, type Temporal } from "@syncmesh/temporal";

/**
 * A relay link's liveness deadline: 2.5 times the keepalive the room announced, re-armed on every
 * frame. A relay that announced none — a hello-less relay — arms nothing.
 */
export interface Liveness {
  /** The room's hello announced this keepalive; the deadline is armed from now. */
  readonly announce: (keepalive: Temporal.Duration) => void;
  /** A new socket, whose room has announced nothing yet. A deadline already armed stays armed. */
  readonly forget: () => void;
  /** A frame arrived: the deadline starts again, when there is a keepalive to arm it from. */
  readonly rearm: () => void;
  /** Disarms the deadline. */
  readonly clear: () => void;
}

/** A liveness with nothing announced, calling `onMute` when an armed deadline passes. */
export function createLiveness(onMute: () => void): Liveness {
  let keepalive: Temporal.Duration | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const rearm = (): void => {
    if (keepalive === undefined) return;
    clearTimeout(deadline);
    deadline = setTimeout(onMute, durationMs(keepalive) * 2.5);
  };
  return {
    announce: (announced) => {
      keepalive = announced;
      rearm();
    },
    forget: () => {
      keepalive = undefined;
    },
    rearm,
    clear: () => clearTimeout(deadline),
  };
}
