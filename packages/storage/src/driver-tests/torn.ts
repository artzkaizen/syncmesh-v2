import type { SuiteCase } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { check, equal } from "@syncmesh/engine";

import type { CrashHarness } from "./crash.js";

import { verifyLog } from "../integrity.js";
import { openStores } from "../open-stores.js";
import { CRASH_AUTHOR, CRASH_TABLES } from "./crash.js";

/**
 * Torn pages in the log itself, beyond the torn state WAL `client/crash.test` covers (D39). The
 * log is the half that cannot be recomputed, so the bar is: a damaged page is refused as a value,
 * never read around. A log that quietly returns the events either side of the hole is a refold
 * that loses acknowledged writes and an anti-entropy answer that tells peers they hold everything.
 *
 * Measured 2026-11-07 on `bun:sqlite`, before D39: 29 tears of 40 like these read back a silent
 * subset (9,991 of 10,000), 2 were refused as values, 9 hit no event page.
 *
 * Runner-neutral like the crash suite: the adapter supplies the crash child and the file handling,
 * since what a page is and how a file is copied belong to the platform — synchronously on a disk,
 * or as a promise where the file sits behind a worker (OPFS) or a runtime (workerd).
 */
export interface TornHarness extends CrashHarness {
  /** Copies the database `from` to `to`, by the names the harness opens them under. */
  readonly copy: (from: string, to: string) => void | Promise<void>;
  /** The log file's size in bytes. */
  readonly size: (name: string) => number | Promise<number>;
  /** Writes `length` zero bytes into the log file at `offset`: what a power cut leaves of a page. */
  readonly zero: (name: string, offset: number, length: number) => void | Promise<void>;
}

const PAGE = 4096;

/** Positions through the file: eight, a ninth of the way apart. */
const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Writes at least `atLeast` events into `name` from the crash child, kills it, and answers how
 * many the log holds — the child runs on past `atLeast` before the kill lands — then closes the
 * store cleanly, so a copy opens without the after-crash check unless a case says otherwise.
 */
const fill = async (harness: TornHarness, name: string, atLeast: number): Promise<number> => {
  const child = harness.start(name, "append");
  try {
    for await (const line of child.lines) if (Number(line) >= atLeast) break;
  } finally {
    await child.kill();
  }
  const stores = (
    await openStores(await harness.openDriver(name), { tables: CRASH_TABLES })
  ).unwrap();
  const held = (await stores.events.allSince(new Map<PeerId, never>(), "synced")).unwrap().length;
  await stores.close();
  return held;
};

/** Half a page of zeros a quarter of the way into the page `at` ninths through `name`. */
const tearAt = async (harness: TornHarness, name: string, at: number) => {
  const page = Math.floor(((await harness.size(name)) / PAGE) * (at / 9));
  await harness.zero(name, page * PAGE + PAGE / 4, PAGE / 2);
  return page;
};

/** Opens `name` and reads it back both ways, or answers the value that refused the open. */
const readBack = async (harness: TornHarness, name: string) => {
  const driver = await harness.openDriver(name);
  const opened = await openStores(driver, { tables: CRASH_TABLES });
  const since = opened.isOk()
    ? await opened.value.events.allSince(new Map<PeerId, never>(), "synced")
    : opened;
  const all = opened.isOk() ? await opened.value.events.all() : opened;
  await driver.close?.();
  return { opened, reads: [since, all] as const };
};

const holeIn = (read: Result<readonly unknown[], { readonly message: string }>) =>
  read.isErr() && read.error.message.startsWith("log has a hole");

/**
 * The cases, for any runner.
 *
 * @example
 * for (const c of tornTests(harness)) test(c.name, c.run, 60_000);
 */
export function tornTests(harness: TornHarness): readonly SuiteCase[] {
  return [
    {
      name: "torn: a damaged page is refused by the read as a value, never read around",
      run: async () => {
        const whole = await fill(harness, "torn-base", 10_000);
        const short: string[] = [];
        let holes = 0;
        for (const at of POSITIONS) {
          const name = `torn-${at}`;
          await harness.copy("torn-base", name);
          const page = await tearAt(harness, name, at);
          const { opened, reads } = await readBack(harness, name);
          // the base closed cleanly, so nothing checked the pages at open: this is the read's answer
          check(opened.isOk(), `page ${page}: a cleanly closed copy opens without a page check`);
          for (const read of reads) {
            // either the damage is a value, or every event is still there — never a subset
            if (read.isOk() && read.value.length < whole)
              short.push(`page ${page}: ${read.value.length} of ${whole}`);
            if (holeIn(read)) holes += 1;
          }
        }
        equal(short, [], "reads that came back short");
        // the read is what refused: without the hole check these tears answer a shorter list
        check(holes > 0, "no tear was refused as a hole");
      },
    },
    {
      name: "torn: after an unclean shutdown, the open checks the pages first",
      run: async () => {
        const whole = await fill(harness, "torn-crash", 10_000);
        let refused = 0;
        for (const at of POSITIONS) {
          const name = `torn-crash-${at}`;
          await harness.copy("torn-crash", name);
          // a session that never reached `close`: the process died with the store open
          const crashed = await harness.openDriver(name);
          (await openStores(crashed, { tables: CRASH_TABLES })).unwrap();
          await crashed.close?.();
          const page = await tearAt(harness, name, at);
          const { opened, reads } = await readBack(harness, name);
          if (opened.isErr()) {
            check(
              opened.error.message.includes("without a clean close"),
              `page ${page}: refused for another reason: ${opened.error.message}`,
            );
            refused += 1;
          } else
            for (const read of reads)
              check(
                read.isErr() || read.value.length === whole,
                `page ${page}: opened past the check and read a subset`,
              );
        }
        check(refused > 0, "no torn copy was refused at open");
      },
    },
    {
      name: "torn: `verifyLog` finds the damage on demand, and passes a sound log",
      run: async () => {
        await fill(harness, "torn-verify", 10_000);
        const sound = await harness.openDriver("torn-verify");
        const verified = await verifyLog(sound);
        check(verified.isOk(), "the sound log failed its check");
        await sound.close?.();
        let found = 0;
        for (const at of POSITIONS) {
          const name = `torn-verify-${at}`;
          await harness.copy("torn-verify", name);
          await tearAt(harness, name, at);
          const driver = await harness.openDriver(name);
          const torn = await verifyLog(driver);
          if (torn.isErr()) {
            equal(torn.error._tag, "StoreFailure", "damage is a store failure");
            found += 1;
          }
          await driver.close?.();
        }
        check(found > 0, "no tear was found by the check");
      },
    },
    {
      name: "torn: a torn tail — `lastSeq` refuses it as a value, and no read throws",
      run: async () => {
        await fill(harness, "torn-tail", 2_000);
        await harness.zero("torn-tail", (await harness.size("torn-tail")) - PAGE / 2, PAGE / 2);
        const driver = await harness.openDriver("torn-tail");
        const stores = (await openStores(driver, { tables: CRASH_TABLES })).unwrap();
        // a tear that takes an author's newest events leaves no later event to show the hole, so
        // the reads may answer either way (D39 B); what is pinned is that they answer, not throw
        await stores.events.all();
        await stores.events.allSince(new Map<PeerId, never>(), "synced");
        const last = await stores.events.lastSeq(CRASH_AUTHOR, "synced");
        check(last.isErr() && last.error._tag === "StoreFailure", "lastSeq read past a torn tail");
        await driver.close?.();
      },
    },
  ];
}
