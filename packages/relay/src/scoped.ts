import type { Coverage, Engine, Interest } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { createHoldback } from "@syncmesh/transport";

import { interestText, sameInterest, scopeFrom } from "@syncmesh/engine";

/** What adopting a scoped coverage needs of the session it runs in. */
export interface ScopedDeps {
  readonly engine: Engine;
  readonly holdback: ReturnType<typeof createHoldback>;
  /** What this session joined with, so a coverage scoped to something else is not adopted. */
  readonly interest: Interest | undefined;
  /** Work behind the session's fold chain, skipped once the session is abandoned. */
  readonly after: (work: () => Promise<void> | void) => void;
  /** Everything the holdback can let go of for these authors, in run order. */
  readonly release: (authors: Iterable<PeerId>) => Promise<void>;
  /** The cursors are from another entitlement: stop acting on this session and re-page. */
  readonly reentitled: () => void;
}

/**
 * Whether the cursors this device holds were earned under `offered` — or under something the
 * relay could only have narrowed from: an unscoped cursor, or an interest with no entitlement,
 * both of which claim the whole of the gated tables. Any change of name is a change: the names
 * are opaque, so a narrowing cannot be told from a widening, and the wrong guess is the one that
 * skips rows forever (D24).
 */
const earnedUnder = (engine: Engine, offered: string | undefined): boolean => {
  const held = scopeFrom(engine.coverage().scope).entitlement;
  return held === undefined || held === offered;
};

/**
 * The three things a last page can do to this device's cursors (D23, D24): adopt the coverage a
 * filtered catch-up ended with, re-scope after a widening repair the relay did not filter, or
 * notice that the cursors were earned behind a gate this run no longer applies.
 */
export function scopedCoverage(deps: ScopedDeps) {
  const { engine, holdback, interest, after, release } = deps;

  /**
   * Takes on the coverage a filtered catch-up ended with — behind the fold chain, so the events it
   * accounts for are folded before this device claims to hold them, exactly as `installSnapshot`
   * adopts a snapshot's coverage only after its rows. A pass-over is one of these too.
   *
   * A coverage scoped to something other than what we asked with is dropped rather than adopted.
   * It would be a claim about a slice this device did not request, and adopting it is precisely
   * how a cursor comes to describe events nobody will ever send again. One scoped to another
   * *entitlement* is worse: the cursors it would replace skip what the old one withheld, so the
   * session is abandoned and the next join asks from nothing.
   */
  const adopt = (scoped: Coverage, repaging: boolean): void => {
    const offered = scopeFrom(scoped.scope);
    // an interest-only scope keeps D23's exact-text rule; one naming an entitlement is compared on
    // what it asks for, since the relay wrote the interest back out of its own copy
    const ours =
      offered.entitlement === undefined
        ? scoped.scope === interestText(interest)
        : sameInterest(offered.interest, interest);
    if (!ours) return;
    after(async () => {
      if (!repaging && !earnedUnder(engine, offered.entitlement)) {
        deps.reentitled();
        return;
      }
      // fold what the coverage is about to claim *before* claiming it. These are events the pages
      // did deliver, which the holdback kept behind a hole the filter made and nothing will fill
      for (const [author, seq] of scoped.synced) {
        const held = holdback.upTo(author, Number(seq));
        // a fold that did not store is a claim the coverage must not make: the next join asks again
        if (held.length > 0 && (await engine.receiveBatch(held)).isErr()) return;
      }
      engine.adoptCoverage(scoped);
      // and then whatever sat above it, which the moved cursor has just made contiguous
      await release(scoped.synced.keys());
    });
  };

  /**
   * After a widening re-page that the relay did not filter: the cursors this device holds are
   * now true for the wider interest, because the repair ran from nothing and delivered the whole
   * run. Saying so is what stops the next join re-paging the same history again.
   */
  const rescope = (): void =>
    after(() => {
      const { synced, local } = engine.coverage();
      const scope = interestText(interest);
      // rebuilt rather than spread, so an interest that widened all the way back to everything
      // drops the old scope instead of carrying it forward
      engine.adoptCoverage(scope === "" ? { synced, local } : { synced, local, scope });
    });

  /**
   * An unfiltered run under cursors earned behind a gate: they skip what the gate withheld, and
   * nothing in this run will offer it again.
   */
  const ungated = (): void =>
    after(() => {
      if (!earnedUnder(engine, undefined)) deps.reentitled();
    });

  /** The end of a catch-up, or a pass-over: whichever of the three this page calls for. */
  return (scoped: Coverage | undefined, repaging: boolean): void => {
    if (scoped !== undefined) adopt(scoped, repaging);
    else if (repaging) rescope();
    else ungated();
  };
}
