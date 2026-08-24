import { createTemplate } from "bingo";
import { z } from "zod";

import pkgJson from "../package.json" with { type: "json" };

/** Template for `bun run gen`: one workspace package with the house layout. */
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
          "index.ts": `export {};
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
