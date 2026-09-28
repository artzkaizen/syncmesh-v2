import type { Engine, Interest } from "@syncmesh/engine";

/** The sources a cold join may ask; a transport with no `requestSnapshot` cannot answer one. */
export interface JoinSources {
  readonly ready: () => Promise<void>;
  readonly list: () => readonly {
    readonly requestSnapshot?: (interest?: Interest, adoptUnvouched?: boolean) => void;
  }[];
}

/**
 * A device that holds nothing asks for state, rather than waiting to be told the whole story.
 *
 * Replaying a log costs one signature check per event, which is the right price for history and
 * the wrong one for a first impression: a workspace of a few hundred issues is thousands of events
 * a new phone must verify before it can draw a row. State plus one certificate over it says the
 * same thing for one signature (RFC-0019).
 *
 * **Only when this device holds nothing.** A replica with coverage already has a cheaper question
 * — the tail above its cursor — and asking for a whole snapshot instead would send it everything
 * it already has. Emptiness is the condition that makes state the cheaper answer, and it is read
 * from coverage rather than from row counts: a device may legitimately hold no rows while knowing
 * it is caught up, and that device wants nothing.
 *
 * **Unvouched state does not retire history here.** `adoptUnvouched: false` is the whole
 * difference between this and `$recovery.rebuild`: nobody asked for this join, so rows that
 * arrive with nothing to check them against are taken as a head start and the events behind them
 * are still fetched and verified. A certificate turns that into the fast path it was meant to be.
 */
export function joinIfEmpty(engine: Engine, sources: JoinSources): Promise<void> {
  if (engine.coverage().synced.size > 0) return Promise.resolve();
  return sources.ready().then(() => {
    // re-read: a session that came up while this was waiting may already have folded the tail,
    // and asking now would request a snapshot this device no longer needs
    if (engine.coverage().synced.size > 0) return;
    for (const source of sources.list()) source.requestSnapshot?.(undefined, false);
  });
}
