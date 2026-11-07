import { CRASH_SCHEMA, crashTests } from "@syncmesh/storage/driver-tests";
import { afterAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-crash-node-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Each line of a child's stdout, as it arrives. */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    yield* lines;
  }
}

describe("@syncmesh/sqlite-node, under Node, survives kill -9", () => {
  const cases = crashTests({
    start: (name, mode) => {
      const child = Bun.spawn(["node", join(import.meta.dir, "crash-child.ts"), dir, name, mode], {
        stdout: "pipe",
        stderr: "inherit",
      });
      return {
        lines: linesOf(child.stdout),
        kill: async () => {
          child.kill("SIGKILL");
          await child.exited;
        },
      };
    },
    openDriver: (name) => Promise.resolve(nodeSqliteDriver(join(dir, `${name}.db`), CRASH_SCHEMA)),
  });
  for (const c of cases) test(c.name, c.run, 60_000);
});
