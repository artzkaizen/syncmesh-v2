import type { SqlValue, SqliteDriver } from "@syncmesh/storage";
import type { CrashHarness, CrashMode, TornHarness } from "@syncmesh/storage/driver-tests";

import { Database } from "bun:sqlite";
import { Miniflare } from "miniflare";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "vite";

import type { Stepped } from "./room.js";

/**
 * Real workerd under Miniflare for the crash suite: `room.ts` bundled once, a runtime per open
 * over one persist directory, so a killed runtime's successor opens the same object's SQLite.
 */

/** The calls `room.ts` answers over RPC, as the stub Miniflare hands back exposes them. */
export interface RoomStub {
  readonly step: (mode: CrashMode, abortAt?: number) => Promise<Stepped>;
  readonly run: (statement: string, params: readonly SqlValue[]) => Promise<void>;
  readonly all: (statement: string, params: readonly SqlValue[]) => Promise<SqlValue[][]>;
}

/** The two calls of a `DurableObjectNamespace` the harness makes, onto `CrashRoom`. */
interface RoomNamespace {
  readonly idFromName: (name: string) => { readonly toString: () => string };
  readonly get: (id: { readonly toString: () => string }) => RoomStub;
}

/** One workerd process and the way into its objects. */
export interface Runtime {
  readonly room: (name: string) => RoomStub;
  /** The object's id as the persist directory names its file. */
  readonly id: (name: string) => string;
  /** SIGKILL to workerd itself, then waits for it to be gone: the runtime dies mid-turn. */
  readonly kill: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/** Bundles `room.ts` for workerd into `dir`: the storage, the engine and the driver in one module. */
export async function bundleRoom(dir: string): Promise<string> {
  await build({
    root: import.meta.dir,
    logLevel: "warn",
    resolve: { conditions: ["@syncmesh/source", "workerd", "worker", "module", "browser"] },
    build: {
      outDir: join(dir, "bundle"),
      emptyOutDir: true,
      minify: false,
      target: "es2022",
      lib: { entry: join(import.meta.dir, "room.ts"), formats: ["es"], fileName: () => "room.js" },
      rolldownOptions: { external: [/^cloudflare:/] },
    },
  });
  return readFile(join(dir, "bundle", "room.js"), "utf8");
}

/** The pids of this process's children named workerd. */
const workerds = () =>
  new Set(
    spawnSync("pgrep", ["-P", `${process.pid}`, "workerd"], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line !== "")
      .map(Number),
  );

const gone = (pid: number) => {
  const probe = spawnSync("kill", ["-0", `${pid}`]);
  return probe.status !== 0;
};

/** Starts workerd over `persist` with the bundled room as its only object class. */
export async function startRuntime(script: string, persist: string): Promise<Runtime> {
  const before = workerds();
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "room.js", contents: script }],
    compatibilityDate: "2026-07-01",
    durableObjects: { ROOM: { className: "CrashRoom", useSQLite: true } },
    durableObjectsPersist: persist,
  });
  await mf.ready;
  const [pid] = [...workerds()].filter((candidate) => !before.has(candidate));
  if (pid === undefined) throw new Error("no workerd process appeared for this Miniflare");
  // SAFETY: Miniflare's proxy onto the `ROOM` binding, a `DurableObjectNamespace`; its published
  // type names the workers-types one this package does not load, so it is read as the two calls made
  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- there is no type to keep: the
     published one resolves to nothing without `@cloudflare/workers-types`, which this package does
     not load, and the two calls below are the whole of what is claimed */
  const namespace = (await mf.getDurableObjectNamespace("ROOM")) as unknown as RoomNamespace;
  let killed = false;
  return {
    room: (name) => namespace.get(namespace.idFromName(name)),
    id: (name) => namespace.idFromName(name).toString(),
    kill: async () => {
      killed = true;
      process.kill(pid, "SIGKILL");
      while (!gone(pid)) await Bun.sleep(10);
    },
    // a killed runtime has nothing left for `dispose` to stop, and it answers so with a throw
    dispose: () =>
      mf.dispose().catch((cause: unknown) => (killed ? undefined : Promise.reject(cause))),
  };
}

/**
 * A driver whose statements run in the object, through `doSqliteDriver` over its own
 * `ctx.storage.sql`, one RPC each: how the suite reads back what a killed runtime left.
 * `close` stops the runtime it opened.
 */
export const roomDriver = (room: RoomStub, runtime: Runtime): SqliteDriver => ({
  dialect: "sqlite",
  log: "inline",
  run: (statement, params = []) => room.run(statement, params),
  all: (statement, params = []) => room.all(statement, params),
  close: () => runtime.dispose(),
});

/**
 * How the suite's child dies: `sigkill` takes workerd itself down at whatever point it has
 * reached, and `reset` has the object call `ctx.abort()` part-way through a batch — a statement
 * of it chosen per round — so the turn holding the batch is thrown away mid-transaction.
 */
export type Death = "sigkill" | "reset";

/** Where in a batch of `statements` the `round`th reset lands: a fifth, two fifths, and on. */
const resetAt = (statements: number, round: number) =>
  Math.max(1, Math.floor((statements * ((round % 4) + 1)) / 5));

/**
 * The crash suite's harness over workerd, its bundle read when a child starts: each child is a runtime over `persist` stepping one
 * object through batches until it dies the way `death` says; each open is a fresh runtime over
 * the same directory, read through {@link roomDriver}.
 */
export function workerdHarness(script: () => string, persist: string, death: Death): CrashHarness {
  let rounds = 0;
  return {
    start: (name, mode) => {
      const { readable, writable } = new TransformStream<string, string>();
      const writer = writable.getWriter();
      const runtime = startRuntime(script(), persist);
      let dying = false;
      let statements = 0;
      const round = rounds++;
      const writing = (async () => {
        const room = (await runtime).room(name);
        while (!dying) {
          const [committed, ran] = await room.step(mode);
          statements = ran;
          // a reader that has seen enough stops reading; what it did not read is not an error
          writer.write(`${committed}`).catch(() => undefined);
        }
        if (death !== "reset") return "killed";
        // the object is reset inside this call, so it never answers; an answer is a batch written whole
        await room.step(mode, resetAt(statements, round));
        return "answered";
      })();
      // the step a death interrupts rejects: that is the death, not a failure of the suite
      const ended = writing
        .catch(() => "died" as const)
        .then(async (how) => {
          await writer.close().catch(() => undefined);
          return how;
        });
      return {
        lines: readable,
        kill: async () => {
          dying = true;
          const started = await runtime;
          if (death === "sigkill") await started.kill();
          const how = await ended;
          await started.dispose();
          if (death === "reset" && how !== "died")
            throw new Error(`the reset in round ${round} did not interrupt its batch`);
        },
      };
    },
    openDriver: async (name) => {
      const runtime = await startRuntime(script(), persist);
      return roomDriver(runtime.room(name), runtime);
    },
  };
}

/**
 * The object's SQLite file at rest, as a disk would hold it once workerd stopped: its WAL folded
 * back in, so a page written at an offset is the page the next runtime reads. workerd leaves the
 * WAL beside the file when it stops, and its `-shm` does not index it (it keeps its WAL index in
 * memory), so the index goes first and the checkpoint rebuilds it from the WAL itself.
 */
const atRest = (file: string) => {
  if (!existsSync(`${file}-wal`)) return file;
  rmSync(`${file}-shm`, { force: true });
  const db = new Database(file);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return file;
};

/**
 * {@link workerdHarness} with the object's file in reach for the torn suite: a copy is the file
 * under another object's id, and a tear is zeros written into it while no runtime holds it.
 */
export function workerdTornHarness(script: () => string, persist: string): TornHarness {
  const ids = new Map<string, string>();
  const file = async (name: string) => {
    let id = ids.get(name);
    if (id === undefined) {
      const runtime = await startRuntime(script(), persist);
      id = runtime.id(name);
      await runtime.dispose();
      ids.set(name, id);
    }
    // Miniflare keeps one directory per object class under the persist root
    const [classDir] = readdirSync(persist);
    return join(persist, classDir ?? "", `${id}.sqlite`);
  };
  return {
    ...workerdHarness(script, persist, "sigkill"),
    copy: async (from, to) => copyFileSync(atRest(await file(from)), await file(to)),
    size: async (name) => statSync(atRest(await file(name))).size,
    zero: async (name, offset, length) => {
      const fd = openSync(atRest(await file(name)), "r+");
      writeSync(fd, new Uint8Array(length), 0, length, offset);
      closeSync(fd);
    },
  };
}
