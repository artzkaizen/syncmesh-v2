import type { CrashHarness } from "@syncmesh/storage/driver-tests";
import type { BrowserContext, Page } from "playwright";

import { crashTests, tornTests } from "@syncmesh/storage/driver-tests";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

import type { Death } from "./opfs-crash/page.js";

/**
 * O16 on OPFS: the crash and torn suites every device driver passes, run in Chromium against
 * `wasmSqliteDriver` on the access-handle pool (`opfs-crash/`).
 *
 * Each suite runs inside the page, since only a browser reaches the files: this builds the page
 * with Vite, serves it on a loopback port (a secure context, which OPFS and Web Locks need), and
 * asks it to run one case at a time. The writer it kills is a dedicated worker writing batch after
 * batch, ended two ways: terminated by the page that started it, and taken down with its page when
 * that page is closed — the page this process opens and closes on the suite's behalf.
 */

interface SuitePage {
  readonly run: (suite: "crash" | "torn" | "open", death: Death, name: string) => Promise<string>;
}
declare const suite: SuitePage;

let out = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let profile = "";
let context: BrowserContext | undefined;
let page: Page | undefined;
const children = new Map<string, Page>();
const logs: string[] = [];

const BUILD = { timeout: 120_000 };
const CASE = { timeout: 120_000 };

const watch = (name: string, watched: Page) => {
  watched.on("console", (message) => logs.push(`[${name}] ${message.type()}: ${message.text()}`));
  watched.on("pageerror", (error) => logs.push(`[${name}] pageerror: ${error.message}`));
  watched.on("worker", (worker) =>
    worker.on("console", (message) => logs.push(`[${name} worker] ${message.text()}`)),
  );
};

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "syncmesh-opfs-crash-"));
  const root = join(import.meta.dir, "opfs-crash");
  await build({
    root,
    logLevel: "warn",
    resolve: { conditions: ["@syncmesh/source", "module", "browser", "development|production"] },
    worker: { format: "es" },
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      target: "es2022",
      rolldownOptions: {
        input: { index: join(root, "index.html"), child: join(root, "child.html") },
      },
    },
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(out, path === "/" ? "index.html" : path)));
    },
  });
  // a profile on disk, as a browser's own is, so the files a killed writer leaves are the ones a
  // browser keeps; an off-the-record context keeps OPFS in memory, which is not what devices run
  profile = await mkdtemp(join(tmpdir(), "syncmesh-opfs-profile-"));
  context = await chromium.launchPersistentContext(profile);
  page = await context.newPage();
  watch("suite", page);
  // the page asks for a writer in a page of its own, and for that page to be closed under it
  await page.exposeFunction("openChildPage", async (path: string) => {
    const child = await context!.newPage();
    watch("child", child);
    children.set(path, child);
    await child.goto(new URL(path, server!.url).href);
  });
  await page.exposeFunction("closeChildPage", async (path: string) => {
    await children.get(path)?.close();
    children.delete(path);
  });
  await page.goto(server.url.href);
  await page.waitForFunction(() => "suite" in globalThis);
}, BUILD.timeout);

afterAll(async () => {
  await context?.close();
  await server?.stop(true);
  for (const made of [out, profile])
    if (made !== "") await rm(made, { recursive: true, force: true });
  // every line a page or worker printed, so a failure here reads with its evidence
  if (logs.length > 0) console.log(logs.join("\n"));
});

/** The suites' case names; the cases themselves run in the page, against its harness. */
const unused: CrashHarness = {
  start: () => {
    throw new Error("the cases run in the page");
  },
  openDriver: () => Promise.reject(new Error("the cases run in the page")),
};
const named = {
  crash: crashTests(unused).map((c) => c.name),
  torn: tornTests({ ...unused, copy: () => {}, size: () => 0, zero: () => {} }).map((c) => c.name),
  open: [
    "open: the log keeps a WAL like the derived half, so a write cut off is recovered (U46)",
    "open: a log that will not attach is refused as a value, and the pool goes back",
    "open: two directories in one thread are two pools, not one under two names",
    "open: two databases opened at once in one directory share its pool",
    "open: a close that lands while another open grows the pool leaves that one the lease",
    "open: a directory whose name is not SQL or URI safe still opens its own pool",
  ],
};

const run = (which: "crash" | "torn" | "open", death: Death) => {
  for (const name of named[which])
    test(
      name,
      async () => {
        const failed = await page!.evaluate(([s, d, n]) => suite.run(s, d, n), [
          which,
          death,
          name,
        ] as const);
        expect(failed).toBe("");
      },
      CASE,
    );
};

describe("@syncmesh/sqlite-wasm on OPFS survives its worker terminated mid-write", () =>
  run("crash", "worker"));
describe("@syncmesh/sqlite-wasm on OPFS survives its page closed mid-write", () =>
  run("crash", "page"));
describe("@syncmesh/sqlite-wasm on OPFS refuses a torn log rather than reading around it (D39)", () =>
  run("torn", "worker"));
describe("@syncmesh/sqlite-wasm on OPFS opens what it is asked for, or refuses it as a value", () =>
  run("open", "worker"));
