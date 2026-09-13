import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** The slice of a mesh the hook reads: `can`, and the grant stream that changes its answer. */
export interface CanSource<R> {
  readonly can: (what: `${string}.${string}`, row?: R) => boolean;
  readonly grants: {
    readonly onRegistered: (listener: (...args: never[]) => void) => () => void;
  };
}

/**
 * A rehearsal descriptor — `api.products.create.can(input)`. `@syncmesh/orpc`'s `CanCall`
 * satisfies it structurally and is not imported, the same way `LiveCall` is not.
 */
export interface CanCall {
  readonly key: string;
  readonly run: () => Promise<{ readonly isOk: () => boolean }>;
  readonly subscribe: (listener: () => void) => () => void;
}

const isRehearsal = <R>(source: CanSource<R> | CanCall): source is CanCall => "run" in source;

/**
 * Whether this caller may do the thing, as React state — re-asked the moment a grant registers,
 * so every gated button flips without a reload.
 *
 * Two shapes, because there are two honest questions. Given a **rehearsal** —
 * `useCan(api.products.create.can({ shopId }))` — the handler runs against the replica and rolls
 * back, which is the real check rather than a prediction of it (book ch. 15); it answers `false`
 * until the first rehearsal returns, because a button drawn before the answer is a guess. Given
 * a **mesh and a rule name**, it asks the rules directly and answers synchronously, which is
 * what a row-level affordance inside a list wants.
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
 */
export function useCan<R>(source: CanSource<R>, what: `${string}.${string}`, row?: R): boolean;
export function useCan(rehearsal: CanCall): boolean;
export function useCan<R>(
  source: CanSource<R> | CanCall,
  what?: `${string}.${string}`,
  row?: R,
): boolean {
  return isRehearsal(source) ? useRehearsed(source) : useRule(source, what, row);
}

/**
 * The rehearsal: asynchronous by nature, so the answer arrives rather than being read.
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
function useRehearsed(call: CanCall): boolean {
  const { key } = call;
  const [allowed, setAllowed] = useState(false);
  const [asked, setAsked] = useState(0);
  const latest = useRef(call);
  latest.current = call;

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

/** The rule, asked directly: synchronous, and what a per-row affordance in a list wants. */
function useRule<R>(
  mesh: CanSource<R>,
  what: `${string}.${string}` | undefined,
  row: R | undefined,
): boolean {
  const subscribe = useCallback((notify: () => void) => mesh.grants.onRegistered(notify), [mesh]);
  const read = useCallback(
    () => (what === undefined ? false : mesh.can(what, row)),
    [mesh, what, row],
  );
  return useSyncExternalStore(subscribe, read);
}
