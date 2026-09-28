import { defineConfig } from "vite";

/**
 * The three-tab harness, served on its own port so 5177 and 5188 keep theirs.
 *
 * `@syncmesh/source` is the condition the rest of the repo resolves under, so the browser runs
 * the TypeScript `tsc` checked rather than whatever `dist/` was last packed from.
 */
export default defineConfig({
  resolve: { conditions: ["@syncmesh/source", "module", "browser", "development|production"] },
  server: { port: 5199, strictPort: true },
});
