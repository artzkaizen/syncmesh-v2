import { Temporal } from "@syncmesh/temporal";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { measureTenant } from "../scale-tenant/measure.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-tenant-ci-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The tenant harness at CI size: every phase runs to `ok` and the device agrees with the
 * authority, on both backends. This guards the harness — the numbers at ten million rows come
 * from the nightly run (`.github/workflows/nightly.yml`), not from here.
 */
describe("scale-tenant at CI size", () => {
  for (const backend of ["sqlite", "pglite"] as const)
    test(`${backend}: every phase completes and the joined device converges`, async () => {
      const results = await measureTenant({
        backend,
        rows: 2_000,
        partitions: 16,
        scoped: 4,
        drift: 0.05,
        budget: Temporal.Duration.from({ minutes: 2 }),
        dir: mkdtempSync(join(dir, `${backend}-`)),
      });
      expect(results.phases.filter((p) => p.status !== "ok")).toEqual([]);
      expect(results.loaded).toBe(2_000);
      expect(Object.values(results.invariants)).toEqual([true, true]);
    }, 180_000);
});
