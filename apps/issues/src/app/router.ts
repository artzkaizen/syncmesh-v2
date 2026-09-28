import { createRouter } from "@tanstack/react-router";

import { routeTree } from "../routeTree.gen.js";

/**
 * The router, built once for the tab.
 *
 * At module scope rather than in a hook, and for the same reason `openReplica` is memoised: the
 * router owns a subscription to the browser's history, and a second one built by a re-render
 * would be a second reader of the address bar wearing the same face. It holds no replica and no
 * context — the mesh reaches the screens through `<Workspace>`, which sits *above* this in
 * `main.tsx` so that a leader handover rebuilds the tree without the URL moving.
 *
 * **`defaultPreload` is off, and the reason it used to give has expired.** It said there was
 * nothing to fetch, because every route's data is a live query against a SQLite database on this
 * device. That was true until the mesh moved into a dedicated worker. Every one of those reads is
 * a `MessagePort` round trip now — the hop measured at 0.014 ms, but the reply arrives as a task,
 * so it cannot land in the frame the click did, and the panel was painting a pending state on
 * every open. Measured at 12 ms between the two renders on a warm mesh.
 *
 * It stays off because that frame was not a fetching problem. The panel was asking the worker for
 * an issue this tab already had in memory — the identical row, out of the identical query, drawn
 * one pane to the left — so it opens on that row instead and there is no pending frame to
 * preload away (`app/detail.tsx`). What would be left to warm on hover is a *live subscription*,
 * and TanStack's preload cache has no dispose hook to release one through: `staleTime` and
 * `gcTime` govern loader data, not a handle a loader opened. A subscription per row the pointer
 * crosses, released by nothing, is a leak bought with a frame that is no longer being spent.
 *
 * If preloading is wanted later, what it needs first is an owner for that subscription, not a
 * flag here.
 */
export const router = createRouter({ routeTree, defaultPreload: false });

/**
 * What makes `to`, `params` and `search` typed at every call site rather than strings that are
 * checked by running the app. Without this declaration `navigate({ to: "/issues/$issueId" })` is
 * as good as `navigate({ to: "/isues/$issueId" })`.
 */
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
