import type { Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { interestFrom, narrows } from "@syncmesh/engine";

import type { ReadGate } from "./read-gate.js";

/**
 * A peer link's answer to a grant that widened (D23, D40): ask from nothing once, and fold what
 * comes back below the cursor.
 *
 * A cursor that stepped over withheld sequences means *"everything below N that I may read"*.
 * Grant this device more and the same number claims the events the old grant kept back, so no
 * peer's diff ever offers them again. The relay re-pages on `regranted`; this is the same repair
 * for a link: the next cursors frame asks from nothing, the far side answers with every event the
 * new grant lets it send, and those below the cursor are folded straight instead of being
 * dropped by the holdback as already held.
 *
 * Once per entitlement per link, not on every exchange: a link that asked under this grant has
 * been answered under it. The cursors are re-scoped to the new entitlement only by the issuer's
 * answer — the one peer that holds every author's run, as the relay is for the relay path. Until
 * then each new link asks from nothing once, which costs a resend and loses nothing.
 */
export interface Repage {
  /** Whether this device's cursors describe a slice narrower than what it may read now. */
  readonly stale: () => boolean;
  /** Called as each cursors frame leaves: whether this one asks from nothing. */
  readonly asks: () => boolean;
  /** Whether an arriving event is folded straight: it is below the cursor of a link re-paging. */
  readonly direct: (event: SyncEvent) => boolean;
  /** A digest arrived: the far side's answer to one cursors frame is complete. */
  readonly answered: () => void;
}

export interface RepageDeps {
  readonly engine: Engine;
  readonly gate: ReadGate | undefined;
  /** What this link asks for, if narrower than everything. */
  readonly interest: Interest | undefined;
  /** The peer the link's handshake proved. */
  readonly peer: () => PeerId | undefined;
}

export function createRepage(deps: RepageDeps): Repage {
  const { engine, gate, interest, peer } = deps;
  /** The entitlement this link last asked from nothing under. */
  let askedUnder: string | undefined;
  /** Which cursors frame, counted from the link's first, asked from nothing. */
  let askedAt: number | undefined;
  let sent = 0;
  let digests = 0;

  const stale = (): boolean => {
    const text = engine.coverage().scope;
    if (gate === undefined || text === undefined) return false;
    const scope = interestFrom(text);
    return !narrows(interest, scope) && !narrows(interestFrom(gate.own()), scope);
  };

  return {
    stale,
    asks: () => {
      sent += 1;
      if (gate === undefined || !stale()) return false;
      const own = gate.own();
      if (askedUnder === own) return false;
      askedUnder = own;
      askedAt = sent;
      return true;
    },
    direct: (event) =>
      askedUnder !== undefined &&
      Number(event.seqNum) <= Number(engine.coverage().synced.get(event.peerId) ?? 0) &&
      stale(),
    answered: () => {
      digests += 1;
      // the far side answers every cursors frame with exactly one digest, in order, so the
      // digest counted at `askedAt` closes the answer to the ask; a lost frame only delays this
      if (gate === undefined || askedAt === undefined || digests < askedAt) return;
      askedAt = undefined;
      if (!gate.whole(peer()) || !stale()) return;
      const { synced, local } = engine.coverage();
      const own = gate.own();
      engine.adoptCoverage(own === "" ? { synced, local } : { synced, local, scope: own });
    },
  };
}
