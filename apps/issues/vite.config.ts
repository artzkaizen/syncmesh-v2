import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  /**
   * **The route tree is generated, not written, and this plugin is the only thing that writes it.**
   *
   * `src/routes/**` is the declaration — a file per URL, a `route.tsx` per layout — and
   * `src/routeTree.gen.ts` is the tree those files add up to, regenerated on every dev start and
   * on every file added or renamed underneath the directory. Nothing imports a route from another
   * route, so a path that moves is a file that moves, and the types for `to`, `params` and
   * `search` follow it without a single hand-edited union.
   *
   * The generated file carries `@ts-nocheck` and is ignored by the repo's lint and format gates
   * (the `routeTree.gen.ts` entry in the root `vite.config.ts`), which is why it sits at that
   * exact path rather than beside the components it wires together.
   *
   * Code splitting is deliberately off. This app's whole point is that it works with the network
   * gone, and a route that fetches its own component on first navigation is a screen that a lost
   * connection can withhold — the one failure mode the rest of the architecture spends its effort
   * making impossible.
   */
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
      autoCodeSplitting: false,
      quoteStyle: "double",
      semicolons: true,
    }),

    /**
     * **React Fast Refresh, without which every edit to this app is a cold boot.**
     *
     * A reload is cheap in an app whose state is in React. It is not cheap here: reloading this
     * page tears down the dedicated worker, re-runs the `navigator.locks` election, re-opens the
     * OPFS database and re-reads the log, so a one-character change to a style put "opening SQLite
     * over OPFS" back on screen. Nothing was wrong with the modules — there was no Fast Refresh
     * boundary in the build at all, so Vite's only remaining move was `page reload`, for every
     * `.tsx` in the app including ones that export nothing but components.
     *
     * The plugin only supplies the boundary; keeping it is the rule the app files obey — **a
     * `.tsx` module exports components and nothing else.** A hook or a context exported beside a
     * component disqualifies the whole module, and every module that imports it, which is why the
     * hooks that read the replica and the shown rows live in `.ts` files of their own.
     */
    viteReact(),
  ],

  /**
   * **`@sqlite.org/sqlite-wasm` must not be pre-bundled, and this is not a preference.**
   *
   * The module fetches `sqlite3.wasm` relative to its own URL. Dependency pre-bundling rewrites
   * that URL to `node_modules/.vite/deps/`, the `.wasm` file is not copied there, and the fetch
   * then lands on the dev server's index page — so SQLite arrives as `SqliteWasmUnavailable` with
   * an HTML parse error inside it, on a line of code that is perfectly correct. Every Vite
   * consumer of `@syncmesh/sqlite-wasm` needs this line; it is in the package's own doc comment
   * for the same reason.
   */
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },

  /**
   * The same condition `tsconfig.json` resolves under, so the dev server runs the TypeScript that
   * `tsc` checked rather than whatever `dist/` was last packed from. Every `@syncmesh/*` package
   * publishes `"@syncmesh/source"` beside `"default"` for exactly this; without it the browser
   * gets a stale build of a workspace package and the two disagree in a way that only shows up as
   * a missing export at runtime.
   */
  resolve: { conditions: ["@syncmesh/source", "module", "browser", "development|production"] },

  run: {
    tasks: {
      typecheck: {
        command: "tsc -p tsconfig.json",
        dependsOn: [{ task: "build", from: "devDependencies" }],
      },
      test: {
        command: "bun test",
        dependsOn: [{ task: "build", from: "devDependencies" }],
      },
    },
  },
});
