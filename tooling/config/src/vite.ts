import { defineConfig } from "vite-plus";

type Platform = "neutral" | "node" | "browser";

const tasks = (testEnv: readonly string[]) => ({
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
    env: [...testEnv],
  },
});

export interface PresetOptions {
  /** Extra entries beside `src/index.ts`, one per subpath export (e.g. `src/driver-tests/index.ts`). */
  readonly entries?: readonly string[];
  /**
   * Variables the test task may read, such as a server URL. Vite Task passes none it is not
   * told about, and each one is part of the cache key, so a run against a server is never
   * replayed for a run without one.
   */
  readonly testEnv?: readonly string[];
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
      deps: { neverBundle: [/^(bun|node|cloudflare):/] },
    },
    run: { tasks: tasks(options.testEnv ?? []) },
  });

/** Vite+ preset for a runtime-neutral library in `packages/*`. */
export const library = (options?: PresetOptions) => preset("neutral", options);

/** Vite+ preset for a runtime adapter in `adapters/*`, built for one platform. */
export const adapter = (platform: Exclude<Platform, "neutral">, options?: PresetOptions) =>
  preset(platform, options);
