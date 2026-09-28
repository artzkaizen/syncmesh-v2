import { adapter } from "@syncmesh/config/vite";

/**
 * `src/worker.ts` is a second entry and not an export.
 *
 * Nothing imports it by name: `driver.ts` reaches it as
 * `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, which every bundler
 * resolves against the file that says it. That only works if `dist/worker.js` is actually beside
 * `dist/index.js`, and it only gets there by being packed.
 */
export default adapter("browser", { entries: ["src/worker.ts"] });
