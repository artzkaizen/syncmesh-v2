import type { Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SyncEvent } from "@syncmesh/kernel";

import { interestText, narrows, scopeFrom } from "@syncmesh/engine";

import type { ReadGate } from "./read-gate.js";

/**
 * A peer link's answer to cursors that describe less than it now asks for (D23, D40): ask from
 * nothing once, and fold what comes back below the cursor.
 *
 * A scoped cursor means *"everything below N that I asked for"*, or *"that I may read"*. Widen
 * either — a link asking for more than the interest a snapshot or a filtered catch-up was scoped
 * to, a window dropped or grown, a grant that names more — and the same number claims events the
 * old scope kept out, so no peer's diff ever offers them again. The relay re-pages on its own
 * join; this is the same repair for a link: the next cursors frame asks from nothing, the far side
 * answers with every event it may send, and those below the cursor are folded straight instead of
 * being dropped by the holdback as already held.
 *
 * Once per link (per entitlement, with a read gate), not on every exchange: a link that asked
 * under this scope has been answered under it. The cursors are re-scoped only by the issuer's
 * answer under a gate — the one peer that holds every author's run, as the relay is for the relay
 * path. With no gate no peer is known to hold every run, so the scope stays and each new link asks
 * from nothing once, which costs a resend and loses nothing.
 */
export interface Repage {
  /** Whether this device's cursors describe a slice narrower than what this link asks for now. */
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
  /** The scope this link last asked from nothing under: the entitlement, or with no gate the interest. */
  let askedUnder: string | undefined;
  /** Which cursors frame, counted from the link's first, asked from nothing. */
  let askedAt: number | undefined;
  let sent = 0;
  let digests = 0;

  const stale = (): boolean => {
    const text = engine.coverage().scope;
    if (text === undefined) return false;
    const scope = scopeFrom(text).interest;
    if (narrows(interest, scope)) return false;
    // behind a gate nothing past this device's own grant can arrive, so a scope it fits is whole
    return gate === undefined || !narrows(scopeFrom(gate.own()).interest, scope);
  };

  return {
    stale,
    asks: () => {
      sent += 1;
      if (!stale()) return false;
      const under = gate === undefined ? interestText(interest) : gate.own();
      if (askedUnder === under) return false;
      askedUnder = under;
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
      // digest counted at `askedAt` closes the answer to the ask. A lost digest only delays
      // this. A lost cursors frame does not: if the ask itself never arrives, the digest
      // answering the next, ordinary cursors frame is counted as its answer, and the cursors
      // are re-scoped over history that was never sent — the same limit as an event lost in
      // transit inside a re-page, which pairing a digest with its ask would close
      if (askedAt === undefined || digests < askedAt) return;
      askedAt = undefined;
      if (gate === undefined || !gate.whole(peer()) || !stale()) return;
      const { synced, local } = engine.coverage();
      engine.adoptCoverage({ synced, local, scope: gate.own() });
    },
  };
}
