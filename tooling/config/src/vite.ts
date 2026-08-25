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

export interface PresetOptions {
  /** Extra entries beside `src/index.ts`, one per subpath export (e.g. `src/driver-tests/index.ts`). */
  readonly entries?: readonly string[];
}

const preset = (platform: Platform, options: PresetOptions = {}) =>
  defineConfig({
    pack: {
      entry: ["src/index.ts", ...(options.entries ?? [])],
      format: ["esm"],
      platform,
      dts: true,
      clean: true,
      fixedExtension: false,
      external: [/^(bun|node|cloudflare):/],
    },
    run: { tasks },
  });

/** Vite+ preset for a runtime-neutral library in `packages/*`. */
export const library = (options?: PresetOptions) => preset("neutral", options);

/** Vite+ preset for a runtime adapter in `adapters/*`, built for one platform. */
export const adapter = (platform: Exclude<Platform, "neutral">, options?: PresetOptions) =>
  preset(platform, options);
