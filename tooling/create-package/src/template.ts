import { createTemplate } from "bingo";
import { z } from "zod";

import pkgJson from "../package.json" with { type: "json" };

/**
 * `vp create package` — one new workspace package, the same shape every time:
 *
 *   <group>/<name>/
 *     package.json      exports → dist, depends on @syncmesh/result
 *     vite.config.ts    export default library()  — the preset from @syncmesh/config
 *     tsconfig.json     editor + typecheck; bun types so bun:test resolves
 *     src/index.ts
 *     src/index.test.ts one todo — red until the first real test (README rule 1)
 *
 * Run from the repo root. Lands in <group>/<name>; --group defaults to packages (runtime-neutral),
 * pass --group adapters for a runtime binding:
 *   bun run gen --name kernel --description "HLC, stamps, merge"
 * (`vp create package` works too, but vp then asks about workspace deps the template already wrote)
 */
export default createTemplate({
  about: { name: pkgJson.name, description: pkgJson.description },

  options: {
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "kebab-case, letters/digits/dashes only")
      .describe("Package name without the @syncmesh/ scope"),
    description: z.string().default("").describe("One line for package.json"),
  },

  produce({ options }) {
    const { name, description } = options;
    const json = <T extends object>(value: T) => `${JSON.stringify(value, null, 2)}\n`;

    return {
      files: {
        "package.json": json({
          name: `@syncmesh/${name}`,
          version: "0.0.0",
          description,
          type: "module",
          license: "MIT",
          files: ["dist"],
          exports: {
            ".": {
              "@syncmesh/source": "./src/index.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
          },
          sideEffects: false,
          dependencies: { "@syncmesh/result": "workspace:*" },
          devDependencies: {
            "@syncmesh/config": "workspace:*",
            "@types/bun": "catalog:",
            typescript: "catalog:",
            "vite-plus": "catalog:",
          },
        }),
        "vite.config.ts": `import { library } from "@syncmesh/config/vite";

export default library();
`,
        "tsconfig.json": json({
          extends: "@syncmesh/config/tsconfig.base.json",
          compilerOptions: { types: ["bun"], noEmit: true, customConditions: ["@syncmesh/source"] },
          include: ["src", "vite.config.ts"],
        }),
        src: {
          "index.ts": `/**
 * @syncmesh/${name} — ${description}
 */
export {};
`,
          "index.test.ts": `import { describe, test } from "bun:test";

describe("@syncmesh/${name}", () => {
  test.todo("first test — a task is done when its test exists and passes", () => {});
});
`,
        },
      },
      scripts: [{ commands: ["vp fmt --write .", "bun install"], phase: 0 }],
      suggestions: ["write the first test, then make it pass"],
    };
  },
});
