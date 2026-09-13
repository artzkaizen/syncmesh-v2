/* oxlint-disable anti-slop/no-unknown-parameters -- this file *is* the thread boundary: a `postMessage` hands over `unknown` and the `kind` is the parse (`adapters/sqlite-wasm`'s protocol.ts disables the same rule for the same reason) */

import type { WirePort } from "@syncmesh/sqlite-wasm";

import type { Control, Elector, Standing } from "./election.js";

import { elect } from "./election.js";

/**
 * A dedicated worker's global scope, as this module uses it.
 *
 * `navigator` is optional because the same three members exist on a page under different
 * meanings, and this shape is what says which of the two this really is. The package compiles
 * against `lib.dom.d.ts`, which does not declare `DedicatedWorkerGlobalScope` at all.
 */
export interface HostScope {
  readonly postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
  readonly navigator?: { readonly locks?: Elector };
}

/**
 * The election and port-serving half of a tab's dedicated worker.
 *
 * **Control goes over the worker's own `onmessage`; the mesh never does.** Everything this worker
 * serves arrives as a transferred `MessagePort` and is served on that port alone — the leader's
 * own tab included, which is why a leader and a follower are the same conversation on both ends.
 * Keeping the global scope for control is not tidiness: `serve` is going to assign `onmessage` on
 * whatever it is handed, and a host that served the global scope would have one connection and no
 * way to accept a second.
 *
 * **Every tab runs this, and at most one of them ever opens a file.** A worker that loses the
 * election holds a queued lock request and nothing else — no SQLite, no OPFS, no heap — until the
 * leader's tab goes away, and then it is already running when it is needed. That is what makes a
 * handover a reconnect rather than a cold start.
 *
 * @example
 * // mesh-worker.ts — a tab's dedicated worker entry
 * hostWorker((port) => serveMesh(port));
 */
export function hostWorker(serve: (port: WirePort) => void): void {
  // SAFETY: this module is only ever reached from a dedicated worker's entry, where `globalThis`
  // is a `DedicatedWorkerGlobalScope` — `postMessage` to the page, `onmessage` from it, and a
  // `WorkerNavigator` carrying the same `LockManager` the page has
  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- there is no type to keep:
     the precise type of this scope is `DedicatedWorkerGlobalScope`, which `lib.dom.d.ts` does not
     declare at all, and `HostScope` is the whole of what is being claimed */
  hostOn(globalThis as unknown as HostScope, serve);
}

/**
 * {@link hostWorker} against a named scope, which is how it is certified without a browser: a
 * `MessageChannel` end and a queue that grants locks stand in for a worker and a `LockManager`,
 * and the sequence they produce is the sequence a real pair does.
 */
export function hostOn(scope: HostScope, serve: (port: WirePort) => void): void {
  const tell = (standing: Standing) => scope.postMessage(standing);
  scope.onmessage = (event) => {
    // SAFETY: the only sender is `openMeshLink` on this worker's own page, whose every post is a
    // `Control`; a message from anywhere else would be a page shouting into a worker it does not own
    const message = event.data as Control;
    if (message.kind === "serve") {
      const port = event.ports[0];
      if (port !== undefined) serve(port);
      return;
    }
    const locks = scope.navigator?.locks;
    if (locks === undefined) {
      tell({ kind: "unelectable" });
      return;
    }
    elect(locks, message.lock, tell);
  };
}
