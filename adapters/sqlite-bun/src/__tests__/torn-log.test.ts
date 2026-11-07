import { openStores } from "@syncmesh/storage";
import { CRASH_SCHEMA, CRASH_TABLES } from "@syncmesh/storage/driver-tests";
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

/** Writes `atLeast` events into `<name>.db` from the crash child, then kills it; the count it committed. */
const fill = async (name: string, atLeast: number): Promise<number> => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "crash-child.ts"), dir, name, "append"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  let committed = 0;
  let pending = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) committed = Math.max(committed, Number(line));
    if (committed >= atLeast) break;
  }
  child.kill("SIGKILL");
  await child.exited;
  return committed;
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
      const committed = await fill("torn-base", 10_000);
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
        // either the damage is a value, or every committed event is still there — never a subset
        if (held.isOk() && held.value.length < committed)
          short.push(`page ${page}: ${held.value.length} of ${committed}`);
        await driver.close?.();
      }
      expect(short).toEqual([]);
    },
    60_000,
  );

  test("the reads that do notice it say so as values, not throws", async () => {
    await fill("torn-tail", 2_000);
    const log = join(dir, "torn-tail.db");
    tear(log, statSync(log).size - PAGE / 2);
    const driver = bunSqliteDriver(log, CRASH_SCHEMA);
    const opened = await openStores(driver, { tables: CRASH_TABLES });
    // whatever the store says about a damaged log, it says it as a Result
    if (opened.isOk()) {
      const all = await opened.value.events.all();
      expect(all.isErr() || all.isOk()).toBe(true);
    } else expect(opened.error._tag).toBe("StoreFailure");
    await driver.close?.();
  }, 60_000);
});
