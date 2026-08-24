#!/usr/bin/env node

import { runTemplateCLI, type Template } from "bingo";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import template from "../src/template.ts";

// vp create swallows --directory and runs with cwd = tooling/; derive the destination here.
const argv = process.argv;
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const workspaceRoot = () => {
  let dir = resolve(import.meta.dirname);
  while (!existsSync(join(dir, "vite.config.ts")) || !existsSync(join(dir, "bun.lock"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("workspace root (vite.config.ts + bun.lock) not found");
    dir = parent;
  }
  return dir;
};
const name = valueOf("--name");
const group = valueOf("--group") ?? "packages";
const groupIndex = argv.indexOf("--group");
if (groupIndex !== -1) argv.splice(groupIndex, 2); // bingo rejects unknown options
if (name !== undefined && !argv.includes("--directory")) {
  argv.push("--directory", join(workspaceRoot(), group, name));
}

// bingo defaults to git/GitHub setup; this generator only writes files.
for (const flag of ["--offline", "--skip-requests"]) {
  if (!argv.includes(flag)) argv.push(flag);
}

// SAFETY: runTemplateCLI takes Template<ZodRawShape>; Template is invariant in its shape, so this is the only cast that compiles.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- third-party invariance
process.exitCode = await runTemplateCLI(template as unknown as Template);
