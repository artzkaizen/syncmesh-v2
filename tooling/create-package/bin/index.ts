#!/usr/bin/env node

import { runTemplateCLI, type Template } from "bingo";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import template from "../src/template.ts";

// `vp create` runs this with cwd = tooling/ and keeps --directory for itself, so resolve the
// destination ourselves: <workspace root>/<group>/<name>, group defaults to packages.
const argv = process.argv;
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const workspaceRoot = (): string => {
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

// A workspace package is local files only: never touch git remotes or the network.
for (const flag of ["--offline", "--skip-requests"]) {
  if (!argv.includes(flag)) argv.push(flag);
}

// SAFETY: bingo's runTemplateCLI takes the base Template<ZodRawShape>, and Template is invariant in its
// options shape, so the precisely typed template cannot be passed or singly asserted. This is the
// scaffold's own idiom; nothing is widened except at this one call into the library.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- third-party invariance, see above
process.exitCode = await runTemplateCLI(template as unknown as Template);
