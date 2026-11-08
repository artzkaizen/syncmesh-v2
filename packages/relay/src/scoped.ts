import type { Coverage, Engine, Interest } from "@syncmesh/engine";
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { TransportContext, createHoldback } from "@syncmesh/transport";

import { entitledInterest, interestText, narrows, sameInterest, scopeFrom } from "@syncmesh/engine";

/**
 * What one join may be served, as the scopes a coverage for it can name (D23): the interest it
 * sent, and that interest cut to this device's own grant — which is what a grant-gated room serves
 * and stamps instead (D40).
 */
export interface JoinedScope {
  readonly sent: Interest | undefined;
  readonly entitled: Interest | undefined;
}

/**
 * The interest cut to this device's own grant, when it holds one (D40): what a gated room serves
 * it and the scope that room stamps on its coverage. `undefined` for a device with no grant,
 * which no gated room seats.
 */
export const entitledScope = (
  context: TransportContext,
  interest: Interest | undefined,
): Interest | undefined => {
  const own = context.grants.grantFor(context.identity.peerId);
  return own === undefined ? undefined : entitledInterest(interest, own.partitions);
};

/**
 * Whether cursors scoped to `scope` still cover what a join asking `interest` may be served. A
 * scope that names the entitlement is held to the entitlement: a device granted more since then
 * is asking for more, and re-pages (D23, D40).
 */
export const covers = (
  context: TransportContext,
  interest: Interest | undefined,
  scope: Interest | undefined,
): boolean => {
  if (narrows(interest, scope)) return true;
  const entitled = entitledScope(context, interest);
  return entitled !== undefined && narrows(entitled, scope);
};

/** What adopting a scoped coverage needs of the session it runs in. */
export interface ScopedDeps {
  readonly engine: Engine;
  readonly holdback: ReturnType<typeof createHoldback>;
  /** What this session last joined with, so a coverage scoped to anything else is not adopted. */
  readonly joined: () => JoinedScope;
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
  const { engine, holdback, joined, after, release } = deps;

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
   *
   * A grant-gated room stamps the interest cut to this device's grant instead of the one sent
   * (D40), so either answers the join. `asked` is read before the page's own grants are
   * registered: one of them can be ours, re-join us under a wider grant, and make a coverage the
   * room built for the old join look like an answer to the new one.
   */
  const adopt = (scoped: Coverage, repaging: boolean, asked: JoinedScope): void => {
    const offered = scopeFrom(scoped.scope);
    // an interest-only scope keeps D23's exact-text rule; one naming an entitlement is compared on
    // what it asks for, since the relay wrote the interest back out of its own copy
    const names = (interest: Interest | undefined): boolean =>
      offered.entitlement === undefined
        ? scoped.scope === interestText(interest)
        : sameInterest(offered.interest, interest);
    const ours = names(asked.sent) || (asked.entitled !== undefined && names(asked.entitled));
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
      const scope = interestText(joined().sent);
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

  /**
   * The end of a catch-up, or a pass-over: whichever of the three this page calls for. `asked` is
   * what the join this page answers was sent with.
   */
  return (scoped: Coverage | undefined, repaging: boolean, asked: JoinedScope): void => {
    if (scoped !== undefined) adopt(scoped, repaging, asked);
    else if (repaging) rescope();
    else ungated();
  };
}

/**
 * The position a join asks from — ours, unless our cursors describe a slice this device has since
 * widened past (D23).
 *
 * A scoped cursor means *"everything below N that I asked for"*. Widen the interest and the
 * same number silently claims events the old filter dropped and the new one wants, so nothing
 * would ever offer them again. Asking from nothing instead re-pages the run under the new
 * interest, and the events that arrive are folded normally — the engine dedups on what it has
 * stored, not on what its cursor claims, so the repair is complete.
 *
 * Narrowing keeps the cursor, because a cursor true for a wider slice is true for a smaller
 * one. So does an unscoped cursor, whose plain meaning is already the stronger claim. A device
 * the room re-entitled (D24) re-pages too, whatever its interest.
 */
export const joinPosition = (
  context: TransportContext,
  interest: Interest | undefined,
  reentitled: boolean,
) => {
  const coverage = context.engine.coverage();
  const repaging = reentitled || !covers(context, interest, scopeFrom(coverage.scope).interest);
  return { cursors: repaging ? new Map<PeerId, SeqNum>() : coverage.synced, repaging };
};
