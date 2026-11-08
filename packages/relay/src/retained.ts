import type { Cursors, Interest } from "@syncmesh/engine";
import type { TransportContext } from "@syncmesh/transport";

import type { LinkReport } from "./link-report.js";
import type { SessionHooks } from "./session.js";

import * as said from "./link-reasons.js";
import { belowFloor } from "./retention.js";
import { joinPosition } from "./scoped.js";

/**
 * A relay link refused with `retention` (gaps U30). The room has trimmed below the cursors the
 * join sent, and it folds nothing, so it has no state to offer either: every redial meets the same
 * refusal until this device holds the floor some other way. So the refusal raises D46's issue for
 * the relay, the link stops dialling, and it dials again once the next join would be at or above
 * the floor — a fold or an adoption moved it — or when it is woken. A join the room serves clears
 * the issue, and so does stopping the link.
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
  /** Dial the room now: this device holds the floor. */
  dial: () => void,
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
    const held = next();
    const floor = new Map([...roomFloor].filter(([author, seq]) => (held.get(author) ?? 0) < seq));
    if (floor.size === 0) return;
    release();
    const check = () => {
      if (belowFloor(next(), floor)) return;
      release();
      ctx.rejoins?.relayCleared(name);
      dial();
    };
    const offs = [ctx.engine.onFoldBatch(check), ctx.engine.onAdopt(check)];
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
