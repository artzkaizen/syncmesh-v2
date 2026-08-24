import type { PlopTypes } from "@turbo/gen";

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * `bun run gen package` — a new workspace package with the same shape as every other:
 * package.json (exports → dist, build/typecheck/test scripts), tsconfig.json (editor +
 * typecheck, bun types), tsconfig.build.json (emit, no runtime types), src/index.ts and a
 * red src/index.test.ts.
 *
 * Non-interactive: `bun run gen package --args kernel packages "HLC, stamps, merge"`
 */
export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("package", {
    description: "New workspace package (packages/* or adapters/*)",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name (without @syncmesh/), kebab-case:",
        validate: (v: string) =>
          /^[a-z][a-z0-9-]*$/.test(v) ? true : "kebab-case, letters/digits/dashes only",
      },
      {
        type: "list",
        name: "group",
        message: "Where does it live?",
        choices: [
          { name: "packages/  — pure TypeScript, runtime-neutral", value: "packages" },
          {
            name: "adapters/  — one runtime binding (bun:sqlite, node:sqlite, wasm, DO…)",
            value: "adapters",
          },
        ],
      },
      { type: "input", name: "description", message: "One-line description:" },
    ],
    actions: [
      {
        type: "addMany",
        destination: "{{ turbo.paths.root }}/{{ group }}/{{ name }}",
        base: "templates/package",
        templateFiles: "templates/package/**",
        globOptions: { dot: true },
      },
      // house style is oxfmt's job, not the templates'
      (answers) => {
        const a = answers as { turbo: { paths: { root: string } }; group: string; name: string };
        const dest = join(a.turbo.paths.root, a.group, a.name);
        const r = spawnSync(
          join(a.turbo.paths.root, "node_modules/.bin/oxfmt"),
          ["--write", dest],
          {
            encoding: "utf8",
          },
        );
        return r.status === 0 ? `formatted ${a.group}/${a.name}` : `oxfmt failed: ${r.stderr}`;
      },
    ],
  });
}
