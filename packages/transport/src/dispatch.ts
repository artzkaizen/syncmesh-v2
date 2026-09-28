import type { Ahead, Cursors } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";

import type { Frame } from "./frame.js";
import type { RouteExchange } from "./route-exchange.js";
import type { SnapshotFrame } from "./snap-frame.js";

/**
 * One arriving frame to the handler that owns it (the bridge's switchboard).
 *
 * Its own seam because the ordering rule lives here rather than in any one handler: the join
 * exchange and the digest are **queued behind the events**, because an install or a comparison
 * that raced the fold would speak about a state this device has not caught up with.
 */
export interface FrameHandlers {
  readonly queued: (run: () => Promise<void> | void) => void;
  readonly onCursors: (from: PeerId, cursors: Cursors, ahead: Ahead | undefined) => void;
  readonly onEvent: (wire: Uint8Array) => void;
  readonly onPresence?: (wire: Uint8Array) => void;
  readonly onDigest: (
    scope: string,
    at: Cursors,
    digests: ReadonlyMap<string, bigint>,
    ahead: Ahead | undefined,
  ) => void;
  readonly onSnapshot: (frame: SnapshotFrame) => Promise<void>;
  readonly routing: RouteExchange;
  /** Grants, the ask for one, and custody — the frames that carry credentials, not data. */
  readonly control: (frame: Frame) => void;
}

const isSnapshotFrame = (frame: Frame): frame is SnapshotFrame => frame.kind.startsWith("snap-");

export function createDispatch(handlers: FrameHandlers): (frame: Frame) => void {
  return (frame) => {
    if (isSnapshotFrame(frame)) {
      handlers.queued(() => handlers.onSnapshot(frame));
      return;
    }
    switch (frame.kind) {
      case "cursors":
        return handlers.onCursors(frame.from, frame.cursors, frame.ahead);
      case "event":
        return handlers.onEvent(frame.wire);
      case "presence":
        return handlers.onPresence?.(frame.wire);
      case "digest":
        return handlers.onDigest(frame.scope, frame.at, frame.digests, frame.ahead);
      case "routes":
        return handlers.routing.learn(frame.ads);
      default:
        return handlers.control(frame);
    }
  };
}
