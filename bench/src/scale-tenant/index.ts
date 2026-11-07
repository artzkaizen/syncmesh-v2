import { Temporal } from "@syncmesh/temporal";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Backend } from "./measure.js";

import { measureTenant } from "./measure.js";
import { markdown } from "./report.js";

/**
 * The tenant at scale, from the command line: the run E17's graduation bar asks for.
 *
 * `bun run --cwd bench scale-tenant -- --rows 10000000 --backend sqlite --budget-minutes 300`
 *
 * `--backend` is `sqlite`, `pglite` or `postgres` (with `--url`, or `SYNCMESH_PG_URL`, naming a
 * throwaway database). Results land in `.bench/scale-tenant-<backend>-<rows>.json`, rewritten after
 * every phase, and as a markdown table on stdout. Exits non-zero when a phase failed or was
 * abandoned, or an invariant did not hold: a run that did not finish is a result, but not a pass.
 */

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};
const number = (name: string, fallback: number) => {
  const value = Number(flag(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const backend = flag("backend") ?? "sqlite";
if (backend !== "sqlite" && backend !== "pglite" && backend !== "postgres")
  throw new Error(`--backend is sqlite, pglite or postgres, not ${backend}`);
const chosen: Backend = backend;
const rows = number("rows", 100_000);
const url = flag("url") ?? process.env.SYNCMESH_PG_URL;
if (chosen === "postgres" && url === undefined)
  throw new Error("--backend postgres needs --url or SYNCMESH_PG_URL");

mkdirSync(".bench", { recursive: true });
const out = join(".bench", `scale-tenant-${chosen}-${rows}.json`);
const dir = mkdtempSync(join(flag("dir") ?? tmpdir(), "syncmesh-tenant-"));

console.log(`scale-tenant: ${rows.toLocaleString()} rows on ${chosen} → ${out}`);
const options = {
  backend: chosen,
  rows,
  partitions: number("partitions", 256),
  scoped: number("scoped", 4),
  drift: number("drift", 0.01),
  budget: Temporal.Duration.from({ minutes: number("budget-minutes", 60) }),
  dir,
  out,
};
const results = await measureTenant(url === undefined ? options : { ...options, url });
rmSync(dir, { recursive: true, force: true });

const table = markdown(results);
console.log(`\n${table}`);
writeFileSync(out.replace(/\.json$/, ".md"), `${table}\n`);
const passed =
  results.phases.every((p) => p.status === "ok") &&
  Object.values(results.invariants).every(Boolean);
if (!passed) process.exitCode = 1;
