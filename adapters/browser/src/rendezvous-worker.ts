import type { ConnectScope } from "./broker.js";

import { broker } from "./broker.js";

/**
 * The `SharedWorker` every tab of this origin connects to.
 *
 * It is its own module because it is its own *kind* of thread: a `SharedWorker` is the one thing
 * a browser gives an origin exactly one of, and that singularity is the entire reason it exists
 * here. It holds no database and can hold none — see {@link broker}.
 *
 * A bundler reaches it through
 * `new SharedWorker(new URL("./rendezvous-worker.js", import.meta.url), { type: "module" })`, the
 * form Vite, Rollup and webpack all detect statically. Pass `rendezvous` to `openMeshLink` if
 * yours does not.
 */

// SAFETY: this module is only ever a shared worker's entry, where `globalThis` is a
// `SharedWorkerGlobalScope` — a scope `lib.dom.d.ts` does not declare, and whose one member this
// file uses is `onconnect`
/* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- there is no type to keep: the
   precise type of this scope is `SharedWorkerGlobalScope`, which the DOM library does not declare
   at all, and `onconnect` is the whole of what is being claimed */
broker(globalThis as unknown as ConnectScope);
