import type { Cursors, Interest } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import { belowRelayFloor } from "@syncmesh/transport";

import type { LinkReport } from "./link-report.js";
import type { SessionHooks } from "./session.js";

import * as said from "./link-reasons.js";
import { joinPosition } from "./scoped.js";

/**
 * A relay link refused with `retention` (gaps U30). The room has trimmed below the cursors the
 * join sent, and it folds nothing, so it has no state to offer either: every redial meets the same
 * refusal until this device holds the floor some other way. So the refusal raises D46's issue for
 * the relay, the link stops dialling, and it dials again once the next join would be at or above
 * the floor — a fold or an adoption moved it — or when it is woken. A join the room serves clears
 * the issue, and so does stopping the link.
 *
 * Until then it still hands over: the room takes what a refused device sends before it hangs up,
 * so a write made here, or a neighbour's carried in, dials once more after the link's backoff.
 *
 * The floor is the one the refusal carries, cut to the authors the next join would still be
 * below. A device that reached it between its join and the refusal is below none of them, and a
 * relay built before the refusal carried a floor says nothing to cut: either way the link redials
 * as for any other close.
 */
export function createRetained(
  /** The relay transport's name, which the issue is raised under. */
  name: string,
  report: LinkReport,
  interest: Interest | undefined,
  /**
   * Dial the room: now, because this device holds the floor; or `later`, after the link's backoff,
   * because something new is waiting to be handed over.
   */
  dial: (later?: boolean) => void,
) {
  let watching: (() => void) | undefined;
  let context: TransportContext | undefined;
  /** Whether the next join asks from nothing (D24): its cursors are then empty. */
  let reentitled = () => false;

  const release = (): void => {
    watching?.();
    watching = undefined;
  };

  const refused = (ctx: TransportContext, roomFloor: Cursors): void => {
    const next = () => joinPosition(ctx, interest, reentitled()).cursors;
    const floor = belowRelayFloor(next(), roomFloor);
    if (floor.size === 0) return;
    release();
    const check = () => {
      if (belowRelayFloor(next(), floor).size > 0) return;
      release();
      ctx.rejoins?.relayCleared(name);
      dial();
    };
    /**
     * A write, or one carried in from a neighbour, while the room still refuses: it is handed
     * over the way the refusal's own push was — a join the room refuses, then everything above
     * its hello's cursors (`refusedBelowFloor`). Holding off until the floor was held kept every
     * write after the first refusal off the room for good on a device that reaches the mesh only
     * through it (chaos soak, `--retention`, seed 22).
     */
    const fresh = () => {
      if (watching === undefined) return;
      release();
      dial(true);
    };
    const offs = [
      ctx.engine.onFoldBatch((batch) => {
        check();
        if (batch.source === "remote") fresh();
      }),
      ctx.engine.onAdopt(check),
      ctx.engine.onOutbound(fresh),
    ];
    watching = () => {
      for (const off of offs) off();
    };
    ctx.rejoins?.relayRefused(name, floor, next);
    report.closing(said.RETAINED);
  };

  return {
    /**
     * One session's hooks, with a `retention` refusal held and a served join clearing the issue.
     * `repaging` says whether the link's next join asks from nothing.
     */
    hooks: (hooks: SessionHooks, ctx: TransportContext, repaging: () => boolean): SessionHooks => {
      context = ctx;
      reentitled = repaging;
      return {
        ...hooks,
        onRefused: (code, floor) => {
          if (code === "retention" && floor !== undefined) refused(ctx, floor);
          hooks.onRefused(code, floor);
        },
        onCaughtUp: () => {
          ctx.rejoins?.relayCleared(name);
          hooks.onCaughtUp();
        },
      };
    },
    /** Whether the link is holding off: a close that follows is not redialled. */
    holding: (): boolean => watching !== undefined,
    /** Stops watching for the floor; the issue stays until a join is served or the link stops. */
    release,
    /** The link stopped: nothing is watched, and the issue goes with it. */
    stop: (): void => {
      release();
      context?.rejoins?.relayCleared(name);
    },
  };
}
