import { watch } from "node:fs";

/**
 * `bun run dev` — build, serve, and rebuild on save.
 *
 * Not HMR, and not for want of trying. TanStack Start's dev middleware installs only when Vite's
 * SSR environment passes an `isRunnableDevEnvironment` check, and that check is a brand
 * comparison against the `vite` **the plugin resolves**. Here that is
 * `@voidzero-dev/vite-plus-core` — the root's `overrides: { vite: "catalog:" }`, which exists so
 * `vite-plus` itself resolves to it and so cannot simply be dropped — while the CLI is upstream
 * Vite. Two copies of Vite, so the check fails and the middleware declines to install, which is
 * why `vite dev` answered a bare 404.
 *
 * `vite build --watch` is no good either: it rebuilds the client environment alone, and Start's
 * server bundle comes out of its own multi-environment pass. So this watches `src`, reruns the
 * whole build — about a second — and restarts the server itself. Not `bun --watch`, because Vite
 * empties `dist` at the start of every build and a watcher pointed at a file that briefly stops
 * existing simply dies. Save, wait a beat, refresh.
 */

const port = Bun.env.PORT ?? "5199";
const entry = "dist/server/server.js";

const build = () =>
  Bun.spawn(["bunx", "vite@7", "build"], {
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  }).exited;

console.log("building…");
if ((await build()) !== 0) throw new Error("the first build failed — see above");

const serve = () =>
  Bun.spawn(["bun", entry], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, PORT: port },
  });

let serving = serve();
console.log(`\n  rounds → http://localhost:${port}\n`);

let queued: ReturnType<typeof setTimeout> | undefined;
let building = false;
const rebuild = () => {
  if (queued !== undefined) clearTimeout(queued);
  // one build per burst: an editor's save is several events, and a save during a build waits
  queued = setTimeout(() => {
    if (building) return;
    building = true;
    console.log("rebuilding…");
    void build().then((code) => {
      building = false;
      if (code !== 0) return; // a broken save leaves the last good server up
      serving.kill();
      serving = serve();
      console.log(`  reloaded → http://localhost:${port}`);
    });
  }, 150);
};
const watcher = watch("src", { recursive: true }, rebuild);

const stop = () => {
  watcher.close();
  serving.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// the watcher is what keeps this alive; the server is restarted under it
await new Promise(() => undefined);
