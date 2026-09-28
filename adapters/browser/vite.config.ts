import { adapter } from "@syncmesh/config/vite";

/**
 * `src/host-worker.ts` is an entry **and** an export, which the index also re-exports.
 *
 * The barrel is the whole adapter: reach `hostWorker` through it and a worker pulls the client,
 * the remote handle, Drizzle and the inspector door before it can ask `navigator.locks` a
 * question — measured at 154 modules against the 2 the election needs. That is paid by every tab
 * of an origin on every load, and all but one of them loses. `host-worker.ts` imports `election.js`
 * and a type, so naming it as its own entry is what makes the sentence in its doc comment — "a
 * worker that loses holds a queued lock request and nothing else" — true of loading as well as of
 * running.
 *
 * `src/rendezvous-worker.ts` is a second entry and not an export.
 *
 * Nothing imports it by name: `tabs.ts` reaches it as
 * `new SharedWorker(new URL("./rendezvous-worker.js", import.meta.url), { type: "module" })`,
 * which every bundler resolves against the file that says it. That only works if
 * `dist/rendezvous-worker.js` is actually beside `dist/index.js`, and it only gets there by being
 * packed.
 */
export default adapter("browser", { entries: ["src/host-worker.ts", "src/rendezvous-worker.ts"] });
