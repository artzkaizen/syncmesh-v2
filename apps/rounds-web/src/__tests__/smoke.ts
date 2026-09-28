import { chromium } from "playwright";

/**
 * Does the app actually work in a browser — `bun run smoke`, against a running `bun run dev`.
 *
 * This exists because the page rendered perfectly while being completely inert, three times over,
 * and nothing in the repo could tell. Server-side the calls were fine; what was broken was only
 * ever visible to something that loads the page and clicks:
 *
 * - the client entry 500'd for a missing React Refresh runtime, so no JavaScript attached at all
 * - the mesh imported `bun:sqlite` while Vite's dev server runs it under Node
 * - and then `Bun.env`, for the same reason
 *
 * Each one left an intact-looking page whose buttons did nothing. A test that fetches HTML would
 * have passed on all three.
 */

const url = process.env["SMOKE_URL"] ?? "http://localhost:5199/";

const browser = await chromium.launch();
const page = await browser.newPage();
const failures: string[] = [];
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});

const check = (held: boolean, what: string) => {
  console.log(`${held ? "ok  " : "FAIL"}  ${what}`);
  if (!held) failures.push(what);
};

await page.goto(url, { waitUntil: "networkidle" });
const main = page.locator("main");
check(await main.isVisible(), "the ward renders");

// counted rather than assumed empty: the mesh keeps its database between runs, and a test that
// only passes on a fresh one is a test that starts lying the second time it is run
const beds = () => page.locator(".bed").count();
const before = await beds();

await page.getByRole("button", { name: /admit a patient/i }).click();
await page.waitForTimeout(2000);
check((await beds()) === before + 1, "admitting a patient adds a bed");

await page.locator(".bed").last().click();
await page.waitForTimeout(1000);

const record = page.getByRole("button", { name: /record a blood pressure/i });
check(await record.isEnabled(), "recording is enabled once someone is admitted");
const readings = () => page.locator(".reading").count();
const had = await readings();
await record.click();
await page.waitForTimeout(2000);
check((await readings()) === had + 1, "the reading appears");
check(!(await main.innerText()).includes("failed:"), "nothing reported a failure");

await browser.close();

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nthe app works.");
