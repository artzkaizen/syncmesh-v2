import type { WirePort } from "@syncmesh/browser";

import { hostWorker } from "@syncmesh/browser/host-worker";

/**
 * The election, and nothing this worker does not need to lose it.
 *
 * Every tab of this origin starts this worker and at most one of them ever opens a file: the
 * worker contends for a Web Lock, and only the winner is ever handed a port. `host.ts` is
 * therefore `await import`ed from inside the callback rather than named at the top — a worker that
 * lost must construct nothing at all *and load nothing at all*, so that when the leader's tab goes
 * it is already running and the handover is a reconnect rather than a cold start.
 *
 * **The static import list is the property.** This file used to name seventeen modules, and
 * `host-worker.ts` documented the opposite — "a worker that loses the election holds a queued lock
 * request and nothing else: no SQLite, no OPFS, no heap" — which was true of every line that runs
 * and false of every line that loads. Measured against the dev server, the graph behind those
 * seventeen was 250 modules and about 215ms warm, paid by every tab on every load, to reach a
 * `navigator.locks` request that needs two.
 *
 * Two changes make the sentence true, and the second is why `hostWorker` is imported from a
 * subpath rather than from `@syncmesh/browser`. The dynamic import below defers the app; the
 * subpath skips the adapter's barrel, which re-exports the client, the remote handle and the
 * inspector door and was 154 of those modules on its own.
 */
let host: Promise<(port: WirePort) => void> | undefined;

hostWorker((port) => {
  host ??= import("./host.js").then((module) => module.openHost());
  void host.then((accept) => accept(port));
});
