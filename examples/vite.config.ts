import { defineConfig } from "vite-plus";

export default defineConfig({
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
