import type { Browser, BrowserContext, Page } from "playwright";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { build } from "vite";

/**
 * The browser's keystore vault over a real IndexedDB, in Chromium (gaps U4): the seed sealed under
 * a non-extractable AES-GCM key the origin keeps, opened again after a reload, the key's bytes out
 * of a script's reach, and a cleared keystore refusing rather than opening.
 */

interface KeystoreSurface {
  readonly kind: () => string | undefined;
  readonly seal: (seedHex: string) => Promise<string>;
  readonly open: (sealedHex: string) => Promise<string>;
  readonly exportKey: () => Promise<string>;
  readonly clear: () => Promise<void>;
}

declare const keystore: KeystoreSurface;

let out = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
const logs: string[] = [];

const BUILD = { timeout: 120_000 };
const DRIVE = { timeout: 30_000 };
const SEED = "ab".repeat(32);

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "syncmesh-keystore-"));
  await build({
    root: join(import.meta.dir, "keystore"),
    logLevel: "warn",
    resolve: { conditions: ["@syncmesh/source", "module", "browser", "development|production"] },
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
  page = await context.newPage();
  page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
}, BUILD.timeout);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.stop(true);
  if (out !== "") await rm(out, { recursive: true, force: true });
  if (logs.length > 0) console.log(logs.join("\n"));
});

const load = async () => {
  await page!.goto(server!.url.href);
  await page!.waitForFunction(() => "keystore" in globalThis);
  return page!;
};

describe("createWebCryptoVault in a browser (U4)", () => {
  test(
    "is the default here, seals the seed, and opens it again after a reload",
    async () => {
      const tab = await load();
      expect(await tab.evaluate(() => keystore.kind())).toBe("webcrypto");
      const sealed = await tab.evaluate((seed) => keystore.seal(seed), SEED);
      expect(sealed.includes(SEED)).toBe(false);
      const again = await load();
      expect(await again.evaluate((bytes) => keystore.open(bytes), sealed)).toBe(SEED);
      // the key the origin keeps cannot be read out by any script on it
      expect(await again.evaluate(() => keystore.exportKey())).toStartWith("refused");
      // a cleared keystore opens nothing, so the next boot refuses rather than reads
      await again.evaluate(() => keystore.clear());
      expect(await again.evaluate((bytes) => keystore.open(bytes), sealed)).toStartWith("refused");
    },
    DRIVE,
  );
});
