import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

/**
 * Routes that span hops (book ch. 17). Online means **routable**, not "this device holds an
 * internet connection": a phone with only BLE, standing next to a peer that has the internet,
 * can reach the authority through it.
 *
 * Deliberately **not a DHT**. The world this serves is a room, a building, a convoy — a bounded
 * advertisement radius with a hop limit, staleness expiry and a forwarding budget, not a global
 * lookup. A route nobody re-advertises simply ages out, which is the only garbage collection a
 * table this size needs.
 */

/** What a route leads to: a named service (`"authority"`) or an instance's peers. */
export type Destination = string;

export interface RouteAd {
  readonly to: Destination;
  /** The peer that advertised it — the next hop from here. */
  readonly via: PeerId;
  /** How many hops beyond `via`; `0` means `via` is the destination itself. */
  readonly hops: number;
  readonly expiresAt: Temporal.Instant;
}

export interface Route {
  readonly to: Destination;
  readonly via: PeerId;
  /** Hops from **this** device, so a direct neighbour is 1. */
  readonly hops: number;
  readonly expiresAt: Temporal.Instant;
}

export interface RouteTable {
  /** What this device itself answers for — advertised to neighbours at hop 0. */
  readonly serve: (to: Destination) => void;
  /** One advertisement heard on a link, from `via`. Refused past the hop limit. */
  readonly learn: (ad: RouteAd) => boolean;
  /** The best route to a destination: fewest hops, ties broken by the later expiry. */
  readonly to: (destination: Destination) => Route | undefined;
  /** Everything currently known, expired entries dropped. */
  readonly all: () => readonly Route[];
  /** What to advertise onward on one link: this device's own services and what it can relay. */
  readonly advertise: (exclude?: PeerId) => readonly RouteAd[];
  /** A hop that failed: every route through it goes, so the next attempt picks another. */
  readonly lost: (via: PeerId) => void;
  /**
   * Fires when what this device can reach changed. Every other link re-advertises on it, which
   * is what carries a route down a chain: A tells B, B's table changes, B tells C.
   */
  readonly onChange: (listener: () => void) => () => void;
}

export interface RouteTableOptions {
  /** This device. Every advertisement it sends names itself as the next hop, because it is. */
  readonly self: PeerId;
  readonly now: () => Temporal.Instant;
  /**
   * How far an advertisement may travel. Past this it is dropped rather than forwarded — the
   * bound that keeps this a room rather than a network.
   */
  readonly maxHops?: number;
  /** How long a heard route stays believed without being re-advertised. Default 60 seconds. */
  readonly ttl?: Temporal.Duration;
}

const DEFAULT_MAX_HOPS = 4;
const DEFAULT_TTL_MS = 60_000;

export function createRouteTable(options: RouteTableOptions): RouteTable {
  const { self, now, maxHops = DEFAULT_MAX_HOPS } = options;
  const ttlMs = options.ttl?.total({ unit: "milliseconds" }) ?? DEFAULT_TTL_MS;
  /** Heard routes, keyed by destination then by the hop they came through. */
  const heard = new Map<Destination, Map<PeerId, Route>>();
  const served = new Set<Destination>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const live = (route: Route): boolean =>
    route.expiresAt.epochMilliseconds > now().epochMilliseconds;

  const prune = (): void => {
    for (const [destination, byHop] of heard) {
      for (const [via, route] of byHop) if (!live(route)) byHop.delete(via);
      if (byHop.size === 0) heard.delete(destination);
    }
  };

  /** Fewest hops wins; a tie goes to the route that stays believed longest. */
  const best = (byHop: Map<PeerId, Route>): Route | undefined => {
    let winner: Route | undefined;
    for (const route of byHop.values()) {
      if (!live(route)) continue;
      if (winner === undefined || route.hops < winner.hops) winner = route;
      else if (
        route.hops === winner.hops &&
        route.expiresAt.epochMilliseconds > winner.expiresAt.epochMilliseconds
      )
        winner = route;
    }
    return winner;
  };

  return {
    serve: (to) => {
      if (served.has(to)) return;
      served.add(to);
      changed();
    },
    learn: (ad) => {
      const hops = ad.hops + 1;
      // the radius, enforced on arrival rather than on send: a peer that ignores the limit
      // cannot make this device forward past it
      if (hops > maxHops) return false;
      if (served.has(ad.to)) return false; // we answer for it ourselves; nothing to learn
      const byHop = heard.get(ad.to) ?? new Map<PeerId, Route>();
      const before = byHop.get(ad.via);
      byHop.set(ad.via, { to: ad.to, via: ad.via, hops, expiresAt: ad.expiresAt });
      heard.set(ad.to, byHop);
      // a refreshed expiry is not news; a new destination or a shorter path is
      if (before === undefined || before.hops !== hops) changed();
      return true;
    },
    to: (destination) => {
      prune();
      const byHop = heard.get(destination);
      return byHop === undefined ? undefined : best(byHop);
    },
    all: () => {
      prune();
      return [...heard.values()].flatMap((byHop) => {
        const winner = best(byHop);
        return winner === undefined ? [] : [winner];
      });
    },
    advertise: (exclude) => {
      prune();
      const expiresAt = now().add({ milliseconds: ttlMs });
      // every ad names **this** device as the next hop, because from the receiver's side it is:
      // what travels is "I can reach X in N hops", not "somebody over there can"
      const mine = [...served].map((to) => ({ to, via: self, hops: 0, expiresAt }));
      const relayed = [...heard.entries()].flatMap(([to, byHop]) => {
        const winner = best(byHop);
        // never back the way it came: the split horizon that stops two peers advertising a
        // route to each other forever, each believing the other knows the way
        if (winner === undefined || winner.via === exclude) return [];
        if (winner.hops >= maxHops) return [];
        return [{ to, via: self, hops: winner.hops, expiresAt: winner.expiresAt }];
      });
      return [...mine, ...relayed];
    },
    lost: (via) => {
      let dropped = false;
      for (const [destination, byHop] of heard) {
        if (byHop.delete(via)) dropped = true;
        if (byHop.size === 0) heard.delete(destination);
      }
      if (dropped) changed();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
