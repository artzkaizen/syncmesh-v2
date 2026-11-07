import { openStores } from "@syncmesh/storage";
import { CRASH_AUTHOR, CRASH_SCHEMA, CRASH_TABLES, linesOf } from "@syncmesh/storage/driver-tests";
import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "syncmesh-torn-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = 4096;

/**
 * Writes at least `atLeast` events into `<name>.db` from the crash child, kills it, and answers
 * how many the log holds: the child runs on past `atLeast` before the kill lands, by more under
 * load, so the reference is what the untorn file reads back rather than what was asked for.
 */
const fill = async (name: string, atLeast: number): Promise<number> => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "crash-child.ts"), dir, name, "append"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  for await (const line of linesOf(child.stdout)) if (Number(line) >= atLeast) break;
  child.kill("SIGKILL");
  await child.exited;
  const driver = bunSqliteDriver(join(dir, `${name}.db`), CRASH_SCHEMA);
  const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
  const held = (await stores.events.allSince(new Map(), "synced")).unwrap().length;
  await driver.close?.();
  return held;
};

/** Half a page of zeros at `offset`: what a power cut leaves of a page the disk was writing. */
const tear = (path: string, offset: number) => {
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.alloc(PAGE / 2, 0), 0, PAGE / 2, offset);
  closeSync(fd);
};

/**
 * Torn pages in the log itself, beyond the torn state WAL `client/crash.test` covers. The log is
 * the half that cannot be recomputed, so the bar is: a damaged page is refused as a value, never
 * read around. A log that quietly returns the events either side of the hole is a refold that
 * loses acknowledged writes and an anti-entropy answer that tells peers they hold everything.
 */
describe("a torn page in the log", () => {
  // OPEN (plan/decisions/D39.md, draft): today the store opens, `lastSeq` fails as a value, but
  // `allSince` returns the events either side of the torn page with no error. Marked `failing` so
  // the suite stays green while it is undecided; when detection lands this flips and must be unmarked.
  test.failing(
    "is refused as a value, never read around",
    async () => {
      const whole = await fill("torn-base", 10_000);
      const base = join(dir, "torn-base.db");
      const pages = statSync(base).size / PAGE;
      // eight positions through the file: measured 2026-11-07, 29 tears of 40 like these read
      // back a silent subset (9,991 of 10,000), 2 were refused as values, 9 hit no event page
      const short: string[] = [];
      for (let at = 1; at <= 8; at += 1) {
        const page = Math.floor((pages * at) / 9);
        const log = join(dir, `torn-${at}.db`);
        copyFileSync(base, log);
        tear(log, page * PAGE + PAGE / 4);
        const driver = bunSqliteDriver(log, CRASH_SCHEMA);
        const opened = await openStores(driver, { tables: CRASH_TABLES });
        const held = opened.isOk()
          ? await opened.value.events.allSince(new Map(), "synced")
          : opened;
        // either the damage is a value, or every event is still there — never a subset
        if (held.isOk() && held.value.length < whole)
          short.push(`page ${page}: ${held.value.length} of ${whole}`);
        await driver.close?.();
      }
      expect(short).toEqual([]);
    },
    60_000,
  );

  test("a torn tail: `lastSeq` refuses it as a value, and no read throws", async () => {
    await fill("torn-tail", 2_000);
    const log = join(dir, "torn-tail.db");
    tear(log, statSync(log).size - PAGE / 2);
    const driver = bunSqliteDriver(log, CRASH_SCHEMA);
    const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
    // `all` and `allSince` read around this tear today (D39); what is pinned is that they answer
    // rather than throw, so a throw from either fails the case
    await stores.events.all();
    await stores.events.allSince(new Map(), "synced");
    const last = await stores.events.lastSeq(CRASH_AUTHOR, "synced");
    expect(last.isErr() && last.error._tag).toBe("StoreFailure");
    await driver.close?.();
  }, 60_000);
});
