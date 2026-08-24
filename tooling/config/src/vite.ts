import { defineConfig } from "vite-plus";

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

/** Vite+ preset for a runtime-neutral library in `packages/*`. */
export const library = () => preset("neutral");

/** Vite+ preset for a runtime adapter in `adapters/*`, built for one platform. */
export const adapter = (platform: Exclude<Platform, "neutral">) => preset(platform);
