import type { PeerId } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";

import type { RouteAdWire } from "./frame.js";
import type { RouteTable } from "./routes.js";

import { routesFrame } from "./frame.js";

/**
 * One link's half of routing (book ch. 17): what this device tells the far side it can reach,
 * and what it believes of what the far side says.
 *
 * Kept out of the bridge because it has one rule of its own worth stating in one place — the
 * next hop is never on the wire. It is whoever sent the frame, which the receiving link already
 * knows and a sender could otherwise lie about, routing traffic through a device that never
 * agreed to carry it.
 */
export interface RouteExchange {
  /** What to advertise now, or nothing when this link has no table or nothing to say. */
  readonly advertisement: () => Uint8Array | undefined;
  /** What the far side says it can reach, recorded against this link's own peer. */
  readonly learn: (ads: readonly RouteAdWire[]) => void;
  /** This link is gone: every route through its peer goes with it. */
  readonly lost: () => void;
}

export interface RouteExchangeDeps {
  /** Explicitly optional rather than an absent key: a link with no table still has an exchange
   *  object, which is what keeps the bridge free of a second "do we route?" branch. */
  readonly routes: RouteTable | undefined;
  /** Whose link this is; `undefined` until the far side has named itself in its cursors. */
  readonly farSide: () => PeerId | undefined;
}

export function createRouteExchange(deps: RouteExchangeDeps): RouteExchange {
  const { routes, farSide } = deps;
  return {
    advertisement: () => {
      if (routes === undefined) return undefined;
      const ads = routes.advertise(farSide()).map((ad) => ({
        to: ad.to,
        hops: ad.hops,
        expiresAtMs: ad.expiresAt.epochMilliseconds,
      }));
      return ads.length === 0 ? undefined : routesFrame(ads);
    },
    learn: (ads) => {
      const peer = farSide();
      if (routes === undefined || peer === undefined) return;
      for (const ad of ads)
        routes.learn({
          to: ad.to,
          via: peer,
          hops: ad.hops,
          expiresAt: Temporal.Instant.fromEpochMilliseconds(ad.expiresAtMs),
        });
    },
    lost: () => {
      const peer = farSide();
      if (peer !== undefined) routes?.lost(peer);
    },
  };
}
