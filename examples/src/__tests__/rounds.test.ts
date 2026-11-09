import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The rounds walkthrough runs and prints what its README says it prints.
 *
 * It is a script, not a suite, and nothing ran it: its calls stopped naming a practice when scope
 * moved into the input, every write was refused `WrongPartition`, and the README went on showing
 * output the script could no longer produce. This runs it as a reader would.
 */
test("the rounds walkthrough converges as its README shows", async () => {
  const run = Bun.spawn(
    ["bun", "--conditions=@syncmesh/source", join(import.meta.dir, "..", "rounds", "device.ts")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) console.log(err);
  expect(code).toBe(0);
  expect(out.trim().split("\n")).toEqual([
    "raj sees: BP 128/84",
    "raj's reading while offline: local",
    "ann: BP=126/82 (amends) | HR=88 | BP=128/84",
    "raj: BP=126/82 (amends) | HR=88 | BP=128/84",
    "raj's reading after reconnect: delivered",
  ]);
}, 60_000);
