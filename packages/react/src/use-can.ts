import { useEffect, useRef, useState } from "react";

/**
 * A rehearsal descriptor — `api.products.create.can(input)`. `@syncmesh/orpc`'s `CanCall`
 * satisfies it structurally and is not imported, the same way `LiveCall` is not.
 */
export interface CanCall {
  readonly key: string;
  readonly run: () => Promise<{ readonly isOk: () => boolean }>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Whether this caller may make the write, as React state — re-asked the moment a grant registers,
 * so every gated button flips without a reload.
 *
 * One shape, one argument: a rehearsal descriptor built from the mutation the affordance would
 * call — `useCan(api.products.create.can({ shopId }))` for a new-row button,
 * `useCan(api.products.update.can({ id: row.id }))` for a row's own. The handler runs against the
 * replica and rolls back, which is the real check rather than a prediction of it (book ch. 15),
 * and the descriptor is the same typed reference the button will fire, so nothing here names a
 * table or a rule by string. It answers `false` until the first rehearsal returns, because a
 * button drawn before the answer is a guess.
 *
 * ```tsx
 * {useCan(api.products.create.can({ shopId })) && <NewProduct />}
 * ```
 *
 * **No `enabled` option, unlike `useQuery` and `useLiveQuery`, and the return type is the reason.**
 * This hook answers `boolean`, so "we did not ask" and "the answer is no" would be the same
 * `false` and no caller could tell them apart — where `useQuery` can say `status: "disabled"` and
 * withhold `data` beside an honest empty array. That collapse is harmless here and nowhere else:
 * `false` is already what an unanswered permission check must render as, because a button drawn
 * before the verdict is a guess, so a disabled check and a refused one want the identical UI.
 * When there is genuinely nothing to ask — no row, no id — build no descriptor and do not render
 * the component that would gate on one.
 *
 * Keyed on `key` and nothing else. A descriptor is built fresh on every render — `can(input)`
 * returns a new object each call — so an effect that depended on the descriptor re-ran on every
 * render, and each run started another rehearsal. A rehearsal takes its handle exclusively until
 * it rolls back, so one per render puts every write the screen makes behind a queue of rehearsals
 * nobody asked for. Before the handle took turns it was worse than slow: a rehearsal still open
 * when an ordinary write committed had its statements committed along with it, and a component
 * that rehearsed `delete` while bumping a view counter deleted the row it was displaying — with no
 * `delete` in the operations ledger to show for it, because the statements rode somebody else's
 * `COMMIT`.
 *
 * `key` is the descriptor's identity and is stable across those rebuilds, which is what it is for.
 * The live descriptor is reached through a ref so that dropping it from the dependencies cannot
 * leave the effect rehearsing a stale input.
 */
export function useCan(rehearsal: CanCall): boolean {
  const { key } = rehearsal;
  const [allowed, setAllowed] = useState(false);
  const [asked, setAsked] = useState(0);
  const latest = useRef(rehearsal);
  latest.current = rehearsal;

  useEffect(() => {
    let live = true;
    const held = latest.current;
    void held.run().then(
      (verdict) => {
        if (live) setAllowed(verdict.isOk());
      },
      () => {
        if (live) setAllowed(false); // a rehearsal that could not run is not permission
      },
    );
    const off = held.subscribe(() => setAsked((n) => n + 1));
    return () => {
      live = false;
      off();
    };
    // `asked` is the re-ask: a grant landing makes the same question worth putting again
  }, [key, asked]);

  return allowed;
}
