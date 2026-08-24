import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "neutral",
    dts: true,
    clean: true,
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: [{ task: "build", from: "dependencies" }],
        output: ["dist/**"],
      },
      typecheck: {
        command: "tsc -p tsconfig.json",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      test: {
        command: "bun test",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
});
