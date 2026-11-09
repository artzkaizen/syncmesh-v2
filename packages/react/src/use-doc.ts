import type { Result } from "@syncmesh/result";

import { useEffect, useState } from "react";

/** The slice of an open document the hook reads: `@syncmesh/docs`'s `OpenDoc`. */
export interface OpenedDoc<D> {
  readonly value: D;
  readonly status: () => "current" | "behind" | "invalidated";
  readonly subscribe: (listener: () => void) => () => void;
  /** Flushes, then lets the handle go; what it says is the runtime's to report, not the hook's. */
  readonly close: () => Promise<object>;
}

/** What `useDoc` opens: a `DocRef` from `mesh.docs.ref(address)`, stable for one address. */
export interface DocSource<D, E> {
  readonly open: () => Promise<Result<OpenedDoc<D>, E>>;
}

/**
 * Where the hook's document stands: `opening` until the runtime hands it over, then the handle's
 * own status (RFC-0023 §4.3), or `failed` with the reason it could not open. `revision` moves on
 * every remote update or status change, since the document object itself keeps its identity.
 */
export type UseDoc<D, E> =
  | { readonly status: "opening"; readonly doc?: undefined; readonly revision: number }
  | {
      readonly status: "failed";
      readonly error: E;
      readonly doc?: undefined;
      readonly revision: number;
    }
  | {
      readonly status: "current" | "behind" | "invalidated";
      readonly doc: D;
      readonly revision: number;
    };

/**
 * A document column as React state (RFC-0023 §4.3): opens `ref` on mount, re-renders when a
 * remote update lands or the status moves, and closes the handle on unmount or when `ref`
 * changes, which flushes what was typed. Edit `doc` with the library's own API; an
 * `invalidated` status means the app reopens (a new ref, or remount).
 *
 * ```tsx
 * const note = useDoc(mesh.docs.ref<LoroDoc>({ table, key, column }));
 * if (note.status === "opening") return <Spinner />;
 * if (note.status === "failed") return <Error error={note.error} />;
 * return <Editor doc={note.doc} />;
 * ```
 */
export function useDoc<D, E>(ref: DocSource<D, E> | undefined): UseDoc<D, E> {
  const [state, setState] = useState<UseDoc<D, E>>({ status: "opening", revision: 0 });
  useEffect(() => {
    if (ref === undefined) return undefined;
    let live = true;
    let handle: OpenedDoc<D> | undefined;
    let unsubscribe = () => {};
    setState((was) => ({ status: "opening", revision: was.revision + 1 }));
    void ref.open().then((opened) => {
      if (opened.isErr()) {
        if (live)
          setState((was) => ({
            status: "failed",
            error: opened.error,
            revision: was.revision + 1,
          }));
        return;
      }
      const held = opened.value;
      handle = held;
      // unmounted while it opened: the handle is let go at once, never leaked
      if (!live) return void held.close();
      const read = () =>
        setState((was) => ({ status: held.status(), doc: held.value, revision: was.revision + 1 }));
      unsubscribe = held.subscribe(read);
      read();
    });
    return () => {
      live = false;
      unsubscribe();
      void handle?.close();
    };
  }, [ref]);
  return state;
}
