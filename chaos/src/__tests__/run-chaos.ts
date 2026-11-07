import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Entry } from "../ledger.js";

/** The package directory, where `run.ts` runs from and its `.chaos/` lands. */
const ROOT = join(import.meta.dir, "..", "..");

/**
 * One `run.ts` in its own process, with what it printed and the ledger it wrote.
 *
 * A failure prints the run's own report, so a red smoke reads like the run did. The seed is fixed
 * by each caller, so a red run replays exactly.
 */
export async function runChaos(args: readonly string[]) {
  const ran = Bun.spawn(["bun", "src/run.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    ran.exited,
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
  ]);
  if (code !== 0) console.error(out, err);
  const path = /ledger: (\S+)/.exec(out)?.[1];
  const lines =
    path === undefined
      ? []
      : readFileSync(join(ROOT, path), "utf8")
          .split("\n")
          .filter((line) => line.length > 0);
  const entries = lines.map((line) => {
    // SAFETY: every line of the file is one `Entry` that `createLedger().text()` serialised
    return JSON.parse(line) as Entry;
  });
  return { code, out, entries };
}
