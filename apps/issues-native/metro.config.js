/**
 * Metro, told two things: where the workspace is, and where Uniwind's stylesheet lives.
 *
 * The `watchFolders`/`nodeModulesPaths` pair is what lets a package two directories up resolve at
 * all. What it deliberately does *not* do is ask for the `@syncmesh/source` condition the web app
 * resolves under: a phone consumes `dist` like any other consumer, because the source of those
 * packages is written against `bun:sqlite` and `node:fs` and a React Native type-check has neither.
 * The cost is that editing a package needs a build before the app sees it; the gain is that this
 * app proves the published artifact works. `withUniwindConfig` must stay the outermost wrapper.
 */
/* oxlint-disable typescript/no-unsafe-return -- Metro's resolver API is untyped: `resolveRequest`
   is declared to return `any`, so every delegation below is an unsafe return by the rule's
   reckoning. Typing it would mean restating Metro's own `Resolution` union here and keeping it in
   step with their releases, which trades a real risk for an imaginary one. */
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("node:path");

const workspace = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [workspace];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(workspace, "node_modules"),
];
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ["require", "import", "react-native"];

/**
 * `./schema.js` meaning `./schema.ts`, which is what the rest of this repo writes.
 *
 * `@syncmesh/issues` is an app rather than a built package, so its export map points at
 * TypeScript source — and that source uses the `.js` specifiers Node's own ESM resolution
 * requires, where the extension names the *output* and the file on disk is `.ts`. Metro has no
 * such rule, so it looks for a `schema.js` nobody ever emits and fails. This is the mapping, and
 * it is confined to relative requests that do not resolve on their own: a real `.js` file still
 * wins, so nothing that works today is redirected.
 */
/**
 * The adapters this platform cannot have, stubbed rather than resolved.
 *
 * `@syncmesh/client` reaches for a Bun or Node SQLite adapter only when no driver was passed, and
 * this app always passes one — but Metro resolves a dynamic import whether or not the branch can
 * run, and those adapters import `node:fs` and `bun:sqlite`. An empty module is the truthful
 * stand-in: the code path is unreachable here, so what it would have imported is nothing.
 */
const ABSENT = new Set(["@syncmesh/sqlite-bun", "@syncmesh/sqlite-node"]);

const sourceExtensions = (context, moduleName, platform) => {
  if (ABSENT.has(moduleName)) return { type: "empty" };
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      return context.resolveRequest(context, moduleName.slice(0, -".js".length), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = sourceExtensions;

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
