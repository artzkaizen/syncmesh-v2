import type { Subprocess } from "bun";
import type { Browser, Page } from "playwright";

import { startRelay } from "@syncmesh/relay";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * The ward in a real browser, against `vite dev` running under **Node** (U6).
 *
 * The page rendered perfectly while being completely inert, more than once, and nothing that
 * fetches HTML could tell. Each fault was visible only to something that loads the page and clicks:
 *
 * - the client entry answered 500 for a missing React Refresh runtime, so no JavaScript attached
 * - the mesh imported `bun:sqlite`, and Vite's dev server runs the server modules under Node
 * - `Bun.env`, for the same reason
 * - a mutation's answer was its `Write` handle, which the server function cannot serialise
 * - every call named no practice, so each write was refused `WrongPartition`
 *
 * So this starts a relay in-process, starts the dev server under Node in a scratch directory (the
 * mesh's `.syncmesh` lands there, so every run starts from an empty ward) and drives the page
 * with Chromium.
 */

const APP = join(import.meta.dir, "..", "..");
const VITE = join(APP, "node_modules", "vite", "bin", "vite.js");
const BOOT = { timeout: 90_000 };
const DRIVE = { timeout: 150_000 };

let scratch = "";
let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
let dev: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
const logs: string[] = [];
const failures: string[] = [];

/**
 * Keeps every line a stream prints in the log, so a failure reads with the server's own words.
 * With a `pattern`, resolves with its first group once printed; without
 * one, resolves when the stream ends.
 */
const follow = (stream: ReadableStream<Uint8Array>, pattern?: RegExp): Promise<string> =>
  new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let seen = "";
    const read = async () => {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        logs.push(text);
        seen += text;
        const found = pattern?.exec(seen)?.[1];
        if (found !== undefined) resolve(found);
      }
      if (pattern === undefined) resolve(seen);
      else reject(new Error(`the stream ended before it printed ${pattern.source}:\n${seen}`));
    };
    read().catch(reject);
  });

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "syncmesh-rounds-web-"));
  relay = await startRelay(0, { dataDir: join(scratch, "relay") });
  // no port: Vite takes 5173 or the next free one, and says which on stdout
  dev = Bun.spawn(["node", VITE, "dev", APP], {
    cwd: scratch,
    // no colour, so the address Vite prints is plain text to match
    env: { ...Bun.env, NO_COLOR: "1", VITE_RELAY_URL: `ws://127.0.0.1:${relay.port}/rounds` },
    stdout: "pipe",
    stderr: "pipe",
  });
  void follow(dev.stderr);
  const url = await follow(dev.stdout, /Local:\s+(http:\/\/\S+)/);

  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    logs.push(`[page] ${message.type()}: ${message.text()}`);
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle" });
}, BOOT.timeout);

afterAll(async () => {
  await browser?.close();
  // SIGTERM first; a dev server that has not gone a few seconds later is killed outright
  dev?.kill();
  const gone = await Promise.race([
    dev?.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (gone === false) dev?.kill("SIGKILL");
  await relay?.stop();
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
  // every line the dev server and the page printed, so a failure reads with its evidence
  if (logs.length > 0) console.log(logs.join(""));
}, BOOT.timeout);

/** Waits until the page holds exactly `count` of `selector`, or reports what it holds instead. */
const settlesAt = async (selector: string, count: number): Promise<number> => {
  const held = page!.locator(selector);
  await page!
    .waitForFunction(
      ([s, n]) => document.querySelectorAll(s).length === n,
      [selector, count] as const,
      {
        timeout: 30_000,
      },
    )
    .catch(() => undefined);
  return held.count();
};

describe("the ward, in a browser (U6)", () => {
  test(
    "admitting a patient adds a bed, and recording a reading shows it",
    async () => {
      const main = page!.locator("main");
      expect(await main.isVisible()).toBe(true);
      // hydrated, or a click lands on server html with no handler behind it: React marks every
      // element it has attached to with a `__reactFiber$…` key, and the server's html has none
      await page!.waitForFunction(
        () => {
          const button = document.querySelector("main button");
          return (
            button !== null && Object.keys(button).some((key) => key.startsWith("__reactFiber"))
          );
        },
        undefined,
        { timeout: 30_000 },
      );

      await page!.getByRole("button", { name: /admit a patient/i }).click();
      expect(await settlesAt(".bed", 1)).toBe(1);

      await page!.locator(".bed").first().click();
      const record = page!.getByRole("button", { name: /record a blood pressure/i });
      expect(await record.isEnabled()).toBe(true);
      await record.click();
      expect(await settlesAt(".reading", 1)).toBe(1);

      await page!.getByRole("button", { name: /admit a patient/i }).click();
      expect(await settlesAt(".bed", 2)).toBe(2);

      expect(await main.innerText()).not.toContain("failed:");
      expect(failures).toEqual([]);
    },
    DRIVE.timeout,
  );
});
