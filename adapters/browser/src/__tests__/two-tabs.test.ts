import type { Browser, BrowserContext, Page } from "playwright";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

/**
 * Two tabs, one database, in a real browser (U11) — and the worker's mesh hearing them (U32).
 *
 * Everything else in this package is certified over a `MessageChannel` with a fake lock room,
 * which proves the protocol and the election and cannot prove the one thing U11 is about: that
 * the second tab of an origin is *served* by the first tab's worker over OPFS rather than refused
 * `OpfsPoolHeld`. So this builds `two-tabs/` with Vite, serves it on a loopback port (a secure
 * context, which Web Locks and OPFS need) and drives it with Chromium: a `SharedWorker`
 * rendezvous, `navigator.locks`, a dedicated worker holding `opfs-sahpool`, and both tabs in one
 * browser context, so one origin and one storage partition.
 */

interface TabSurface {
  readonly role: () => Promise<"leader" | "follower" | undefined>;
  readonly failure: () => string;
  readonly write: (id: string, body: string) => Promise<void>;
  readonly ids: () => Promise<string[]>;
  readonly session: () => Promise<string | undefined>;
  readonly seen: () => number[];
  readonly durable: () => Promise<{ root: string[]; held: string[] }>;
  readonly direct: () => Promise<string>;
  readonly hide: () => void;
  readonly show: () => void;
}

declare const tab: TabSurface;

let out = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const logs: string[] = [];

const BUILD = { timeout: 120_000 };
const DRIVE = { timeout: 60_000 };

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "syncmesh-two-tabs-"));
  await build({
    root: join(import.meta.dir, "two-tabs"),
    logLevel: "warn",
    resolve: { conditions: ["@syncmesh/source", "module", "browser", "development|production"] },
    worker: { format: "es" },
    build: { outDir: out, emptyOutDir: true, minify: false, target: "es2022" },
  });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(out, path === "/" ? "index.html" : path)));
    },
  });
  browser = await chromium.launch();
  context = await browser.newContext();
}, BUILD.timeout);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop(true);
  if (out !== "") await rm(out, { recursive: true, force: true });
  // every line a page or worker printed, so a failure here reads with its evidence
  if (logs.length > 0) console.log(logs.join("\n"));
});

const open = async (name: string): Promise<Page> => {
  const page = await context!.newPage();
  page.on("console", (message) => logs.push(`[${name}] ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`[${name}] pageerror: ${error.message}`));
  page.on("worker", (worker) =>
    worker.on("console", (message) => logs.push(`[${name} worker] ${message.text()}`)),
  );
  await page.goto(server!.url.href);
  await page.waitForFunction(() => "tab" in globalThis);
  return page;
};

/**
 * Asks again until the page answers `want`, so a fold crossing two ports has time to land.
 *
 * A refusal is an answer too, and asked past: a call out when the host's tab closes settles as
 * `MeshHostGone` by design, and the tab asks again on its next link.
 */
const until = async <T>(page: Page, read: () => Promise<T> | T, want: T): Promise<T | string> => {
  const deadline = Date.now() + 15_000;
  const ask = () => page.evaluate(read).catch((cause: unknown) => String(cause));
  let last = await ask();
  while (Date.now() < deadline && !Bun.deepEquals(last, want)) {
    await Bun.sleep(50);
    last = await ask();
  }
  return last;
};

describe("two tabs of one origin, one database (U11)", () => {
  let a: Page;
  let b: Page;

  test(
    "the second tab is served by the first tab's worker, not refused the pool",
    async () => {
      a = await open("a");
      expect(await a.evaluate(() => tab.role())).toBe("leader");
      b = await open("b");
      expect(await b.evaluate(() => tab.role())).toBe("follower");
      expect(await b.evaluate(() => tab.failure())).toBe("");
      // on the access-handle pool, which one context of the origin holds: the elected worker
      expect(await b.evaluate(() => tab.durable())).toEqual({
        root: ["syncmesh"],
        held: ["syncmesh-mesh:/syncmesh", "syncmesh-opfs:/syncmesh/pool"],
      });
    },
    DRIVE,
  );

  test(
    "a tab that opens a database of its own beside the mesh is refused, which is what the host spares it",
    async () => {
      expect(await b.evaluate(() => tab.direct())).toBe("OpfsPoolHeld");
    },
    DRIVE,
  );

  test(
    "a write in either tab is one row in the one database, and re-runs the other's live query",
    async () => {
      await a.evaluate(() => tab.write("n1", "from a"));
      await b.evaluate(() => tab.write("n2", "from b"));

      expect(await until(a, () => tab.ids(), ["n1", "n2"])).toEqual(["n1", "n2"]);
      expect(await until(b, () => tab.ids(), ["n1", "n2"])).toEqual(["n1", "n2"]);
      // the live query in a re-ran on b's write, which only a fold on the one host can cause
      expect(await until(a, () => tab.seen().at(-1), 2)).toBe(2);
      expect(await until(b, () => tab.seen().at(-1), 2)).toBe(2);
    },
    DRIVE,
  );

  test(
    "the worker's mesh marks the session clean once both tabs are hidden, and open with one back (U32)",
    async () => {
      expect(await b.evaluate(() => tab.session())).toBe("open");
      await a.evaluate(() => tab.hide());
      // one tab is still shown, so the origin is still in front
      await Bun.sleep(200);
      expect(await b.evaluate(() => tab.session())).toBe("open");

      await b.evaluate(() => tab.hide());
      expect(await until(b, () => tab.session(), "closed")).toBe("closed");

      await b.evaluate(() => tab.show());
      expect(await until(b, () => tab.session(), "open")).toBe("open");
    },
    DRIVE,
  );

  test(
    "closing the host's tab hands the database to the other, with every row still in it",
    async () => {
      await a.close({ runBeforeUnload: true });
      expect(await until(b, () => tab.role(), "leader")).toBe("leader");
      expect(await until(b, () => tab.ids(), ["n1", "n2"])).toEqual(["n1", "n2"]);

      // and a tab opened now is served by the new host, over the same file
      const c = await open("c");
      expect(await c.evaluate(() => tab.role())).toBe("follower");
      expect(await until(c, () => tab.ids(), ["n1", "n2"])).toEqual(["n1", "n2"]);
      await c.close();
    },
    DRIVE,
  );
});
