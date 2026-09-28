import type { WirePort } from "./protocol.js";

import { serveSqlite } from "./host.js";

/**
 * The dedicated worker `wasmSqliteDriver` starts when it is called from a window.
 *
 * It is its own module because the durable VFSes are their own thread: everything below here —
 * SQLite's WASM heap, the access-handle pool, the database and its journal — has to sit on the
 * side of the boundary where `FileSystemFileHandle.createSyncAccessHandle` is defined, and this
 * file is that side.
 *
 * A bundler reaches it through `new Worker(new URL("./worker.js", import.meta.url), { type:
 * "module" })`, the form Vite, Rollup and webpack all detect statically. Pass
 * `worker` to `wasmSqliteDriver` if yours does not.
 */

// SAFETY: this module is only ever a dedicated worker's entry, where `globalThis` is a
// `DedicatedWorkerGlobalScope` — `postMessage` to the page, `onmessage` from it. The package
// compiles against `lib.dom.d.ts`, which declares the same two members on `Window` with different
// meanings, so the shape already matches and the assertion says which of the two this really is.
/* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- there is no type to keep: the
   precise type of this scope is `DedicatedWorkerGlobalScope`, which `lib.dom.d.ts` does not
   declare at all, and the two members below are the whole of what is being claimed */
serveSqlite(globalThis as unknown as WirePort);
