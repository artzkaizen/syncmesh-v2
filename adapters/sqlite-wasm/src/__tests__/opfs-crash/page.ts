/**
 * The suite page `opfs-crash.test.ts` drives: the crash and torn suites every device driver runs,
 * run here against `wasmSqliteDriver` on the access-handle pool, because OPFS exists only in a
 * browser and the suites read the database back after each death.
 *
 * Reads go through `wasmSqliteDriver` from this window, which opens the database in the package's
 * own worker as an app's page does. Writes go through a worker of the suite's (`child.ts`), which
 * dies one of two ways: `worker` terminates it, `page` closes the page that started it.
 */
import type { CrashHarness, CrashMode, TornHarness } from "@syncmesh/storage/driver-tests";

import { CRASH_SCHEMA, crashTests, tornTests } from "@syncmesh/storage/driver-tests";
import { Temporal } from "@syncmesh/temporal";

import type { ChildOrder, FileAnswer, FileOrder } from "./messages.js";

import { wasmSqliteDriver } from "../../index.js";
import { SLOTS, told } from "./messages.js";

/** How a writer dies. */
export type Death = "worker" | "page";

/** What the test process provides the page: another page of this origin, opened and closed. */
declare global {
  var openChildPage: (path: string) => Promise<void>;
  var closeChildPage: (path: string) => Promise<void>;
  var suite: {
    readonly run: (suite: "crash" | "torn" | "open", death: Death, name: string) => Promise<string>;
  };
}

/** Each death writes under its own directory, so each has its own pool and its own databases. */
const crashDirectory = (death: Death) => `/syncmesh-crash-${death}`;

/** Each line a channel carries, until `close` or until the reader stops: what `lines` is built from. */
const listen = (name: string) => {
  const channel = new BroadcastChannel(name);
  // the reader stops once it has heard enough, which cancels the stream under the channel
  let open = true;
  let controller: ReadableStreamDefaultController<string> | undefined;
  const lines = new ReadableStream<string>({
    start: (taken) => void (controller = taken),
    cancel: () => void (open = false),
  });
  channel.addEventListener("message", ({ data }: MessageEvent<string>) => {
    // a writer that could not open its database says why rather than going quiet
    if (data.startsWith("failed")) {
      open = false;
      controller?.error(new Error(data));
    } else if (open) controller?.enqueue(data);
  });
  return {
    lines,
    close: () => {
      channel.close();
      if (open) controller?.close();
      open = false;
    },
  };
};

const writer = (death: Death, name: string, mode: CrashMode) => {
  const order = {
    channel: `crash:${crypto.randomUUID()}`,
    directory: crashDirectory(death),
    name,
    mode,
  } satisfies ChildOrder;
  const heard = listen(order.channel);
  if (death === "worker") {
    const worker = new Worker(new URL("./child.ts", import.meta.url), { type: "module" });
    worker.postMessage(order);
    return {
      lines: heard.lines,
      kill: async () => {
        worker.terminate();
        heard.close();
      },
    };
  }
  const path = `/child.html?${new URLSearchParams({ ...order })}`;
  const opened = globalThis.openChildPage(path);
  return {
    lines: heard.lines,
    kill: async () => {
      await opened;
      await globalThis.closeChildPage(path);
      heard.close();
    },
  };
};

/** One order to a fresh file worker, answered once and then terminated. */
const fileOrder = (order: FileOrder): Promise<number> =>
  new Promise((settle, refuse) => {
    const worker = new Worker(new URL("./files.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", ({ data }: MessageEvent<FileAnswer>) => {
      worker.terminate();
      if ("failed" in data) refuse(new Error(data.failed));
      else settle(data.size);
    });
    worker.postMessage(order);
  });

const harness = (death: Death): TornHarness => {
  const directory = crashDirectory(death);
  const crash: CrashHarness = {
    start: (name, mode) => writer(death, name, mode),
    openDriver: async (name) =>
      (
        await wasmSqliteDriver({
          name,
          schema: CRASH_SCHEMA,
          storage: "opfs-sahpool",
          directory,
          whenHeld: "wait",
          capacity: SLOTS,
        })
      ).unwrap(),
  };
  return {
    ...crash,
    copy: async (from, to) => void (await fileOrder({ op: "copy", directory, from, to })),
    size: (name) => fileOrder({ op: "size", directory, name }),
    zero: async (name, offset, length) =>
      void (await fileOrder({ op: "zero", directory, name, offset, length })),
  };
};

/**
 * What a log the disk damaged does to the open itself, beside the suites: a log whose schema page
 * is gone will not attach, and that is a refusal the caller holds as a value — not a panic from
 * giving the pool back while the half that did open still holds its handle.
 */
const openCases = (death: Death) => {
  const opened = harness(death);
  return [
    {
      name: "open: the log keeps a WAL like the derived half, so a write cut off is recovered (U46)",
      run: async () => {
        const driver = await opened.openDriver("journaled");
        const modes = [
          await driver.all("PRAGMA main.journal_mode"),
          await driver.all(`PRAGMA syncmesh.journal_mode`),
        ];
        await driver.close?.();
        // on the rollback journal the pool's VFS never rolls back a journal a killed writer left
        if (JSON.stringify(modes) !== JSON.stringify([[["wal"]], [["wal"]]]))
          throw new Error(`journal modes, derived half then log: ${JSON.stringify(modes)}`);
      },
    },
    {
      name: "open: a log that will not attach is refused as a value, and the pool goes back",
      run: async () => {
        const first = await opened.openDriver("unattachable");
        await first.run("CREATE TABLE syncmesh.kept (a TEXT)");
        await first.run("INSERT INTO syncmesh.kept (a) VALUES ('x')");
        await first.close?.();
        // the page past the header holds the schema's root: without it the ATTACH reads garbage
        await opened.zero("unattachable", 100, 3996);
        const refused = await wasmSqliteDriver({
          name: "unattachable",
          schema: CRASH_SCHEMA,
          storage: "opfs-sahpool",
          directory: crashDirectory(death),
          whenHeld: "wait",
          capacity: SLOTS,
        });
        if (!refused.isErr() || refused.error._tag !== "OpfsUnavailable")
          throw new Error(
            `the damaged log opened, or was refused as ${refused.isErr() ? refused.error._tag : "nothing"}`,
          );
        // and the pool is free again: another database under the same directory opens
        const other = await opened.openDriver("beside");
        await other.close?.();
      },
    },
    {
      name: "open: two directories in one thread are two pools, not one under two names",
      run: async () => {
        const open = (directory: string) =>
          wasmSqliteDriver({
            name: "twin",
            schema: CRASH_SCHEMA,
            storage: "opfs-sahpool",
            directory,
            whenHeld: "wait",
            capacity: SLOTS,
          }).then((driver) => driver.unwrap());
        const [left, right] = [
          await open("/syncmesh-twin-left"),
          await open("/syncmesh-twin-right"),
        ];
        await left.run("CREATE TABLE syncmesh.only_left (a TEXT)");
        const seen = await right.all(
          "SELECT name FROM syncmesh.sqlite_master WHERE name = 'only_left'",
        );
        await left.close?.();
        await right.close?.();
        if (seen.length > 0) throw new Error("the second directory opened the first one's log");
      },
    },
    {
      name: "open: two databases opened at once in one directory share its pool",
      run: async () => {
        // a directory of its own, so no case before this one has woken its pool
        const directory = `/syncmesh-together-${crypto.randomUUID()}`;
        const [first, second] = await Promise.all([
          openIn(directory, "first"),
          openIn(directory, "second"),
        ]);
        if (first.isErr()) throw new Error(`refused at once: ${told(first.error)}`);
        if (second.isErr()) throw new Error(`refused at once: ${told(second.error)}`);
        await first.value.run("CREATE TABLE syncmesh.kept (a TEXT)");
        await second.value.run("CREATE TABLE syncmesh.kept (a TEXT)");
        await first.value.close?.();
        await second.value.close?.();
      },
    },
    {
      name: "open: a close that lands while another open grows the pool leaves that one the lease",
      run: async () => {
        const directory = `/syncmesh-grown-${crypto.randomUUID()}`;
        const first = (await openIn(directory, "first", SLOTS / 4)).unwrap();
        // the second asks for more slots than the pool has, so its open is still adding them
        // when the last store before it closes
        const growing = openIn(directory, "grown");
        await new Promise((wake) => setTimeout(wake, GROWING.total("milliseconds")));
        await first.close?.();
        const grown = await growing;
        if (grown.isErr()) throw new Error(`refused beside a close: ${told(grown.error)}`);
        const held = (await navigator.locks.query()).held ?? [];
        const leased = held.some((lock) => lock.name === `syncmesh-opfs:${directory}/pool`);
        await grown.value.run("CREATE TABLE syncmesh.kept (a TEXT)");
        await grown.value.close?.();
        if (!leased) throw new Error("the open store holds the pool without its lease");
      },
    },
    {
      name: "open: a directory whose name is not SQL or URI safe still opens its own pool",
      run: async () => {
        // the pool's VFS name carries the directory, and the ATTACH names the VFS
        const directory = `/syncmesh-it's & #${crypto.randomUUID()}`;
        const opened = await openIn(directory, "odd");
        if (opened.isErr()) throw new Error(`refused: ${told(opened.error)}`);
        await opened.value.run("CREATE TABLE syncmesh.kept (a TEXT)");
        await opened.value.close?.();
      },
    },
  ];
};

/** Long enough for an open to be past the lease and into adding slots, short of finishing them. */
const GROWING = Temporal.Duration.from({ milliseconds: 20 });

/** A store of its own under `directory`, refused at once if another context holds the pool. */
const openIn = (directory: string, name: string, capacity = SLOTS) =>
  wasmSqliteDriver({ name, schema: CRASH_SCHEMA, storage: "opfs-sahpool", directory, capacity });

const suites = {
  crash: (death: Death) => crashTests(harness(death)),
  torn: (death: Death) => tornTests(harness(death)),
  open: openCases,
} satisfies Record<string, (death: Death) => ReturnType<typeof crashTests>>;

globalThis.suite = {
  run: async (suite, death, name) => {
    const found = suites[suite](death).find((c) => c.name === name);
    if (found === undefined) return `no case named ${name}`;
    try {
      await found.run();
      return "";
    } catch (cause) {
      return `${told(cause)}\n${cause instanceof Error ? (cause.stack ?? "") : ""}`;
    }
  },
};
