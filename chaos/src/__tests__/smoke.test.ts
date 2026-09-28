import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The chaos harness in CI (gap audit №10): one small seeded run on every test pass, so the
 * convergence oracle and the zero-handles epilogue guard every push instead of only the runs
 * somebody remembers to start. A failure prints the run's own report; the seed is fixed so a
 * red run replays exactly.
 */
describe("chaos smoke", () => {
  test("a small seeded run converges and leaks nothing", async () => {
    const chaos = join(import.meta.dir, "..", "..");
    const ran = Bun.spawn(["bun", "src/run.ts", "--seed", "11", "--devices", "4", "--ticks", "8"], {
      cwd: chaos,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await ran.exited;
    const out = await new Response(ran.stdout).text();
    if (code !== 0) console.error(out, await new Response(ran.stderr).text());
    expect(out).toContain("converged");
    expect(code).toBe(0);
  }, 60_000);
});
