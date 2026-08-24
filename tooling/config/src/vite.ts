import { defineConfig } from "vite-plus";

/**
 * Every package's `vite.config.ts` is two lines: import a preset, export it.
 * The policy — how a package builds, type-checks and tests — lives here, once.
 */

type Platform = "neutral" | "node" | "browser";

const tasks = {
  build: {
    command: "vp pack",
    dependsOn: [{ task: "build", from: "dependencies" as const }],
    output: ["dist/**"],
  },
  typecheck: {
    command: "tsc -p tsconfig.json",
    dependsOn: [{ task: "build", from: "dependencies" as const }],
  },
  test: {
    command: "bun test",
    dependsOn: [{ task: "build", from: "dependencies" as const }],
  },
};

const preset = (platform: Platform) =>
  defineConfig({
    pack: { entry: ["src/index.ts"], format: ["esm"], platform, dts: true, clean: true },
    run: { tasks },
  });

/** `packages/*` — pure TypeScript, no runtime assumed (D01-B). */
export const library = () => preset("neutral");

/** `adapters/*` — one runtime binding; say which. */
export const adapter = (platform: Exclude<Platform, "neutral">) => preset(platform);
