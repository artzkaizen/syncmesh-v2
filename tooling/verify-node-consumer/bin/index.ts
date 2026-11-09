#!/usr/bin/env node

/**
 * The consumer check the test suite cannot give us: Bun runs every test, and Bun tolerates what
 * Node rejects — extensionless imports, `bun:*` at the top level, a missing `exports` entry.
 * So: pack what would ship, install the tarballs into an empty project, and `import()` each
 * package with real `node` (and with `bun`, the packages that declare only `engines.bun`). The
 * client gets one step more under each runtime: a durable round trip over the platform's default
 * store, in three processes — write, reopen and read back, then delete the state and refold it
 * from the log — so `@syncmesh/sqlite-node` is proved under Node and `@syncmesh/sqlite-bun` under
 * Bun, each from its packed tarball.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly engines?: { readonly bun?: string; readonly node?: string };
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface Publishable {
  readonly name: string;
  readonly dir: string;
  /** Declares `engines.bun` and not `engines.node`: installable everywhere, importable only on Bun. */
  readonly bunOnly: boolean;
  /**
   * Peers on `react-native` or `expo-sqlite`: installable everywhere, importable only under a React
   * Native runtime, whose own entry points are Flow source that plain `node` cannot parse.
   */
  readonly nativeOnly: boolean;
}

const bunOnly = (manifest: Manifest): boolean =>
  manifest.engines?.bun !== undefined && manifest.engines.node === undefined;

/** The runtimes whose packages do not load in plain `node`, named by the peer that brings them. */
const NATIVE_PEERS = ["react-native", "expo-sqlite"] as const;

const nativeOnly = (manifest: Manifest): boolean =>
  NATIVE_PEERS.some((peer) => manifest.peerDependencies?.[peer] !== undefined);

const publishable = (): readonly Publishable[] =>
  ["packages", "adapters"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, group, entry.name))
      .flatMap((dir) => {
        let manifest: Manifest;
        try {
          // SAFETY: a workspace package.json — `name` is required by npm and `private`/`engines` are optional
          manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
        } catch {
          return [];
        }
        if (manifest.private === true) return [];
        return [
          {
            name: manifest.name,
            dir,
            bunOnly: bunOnly(manifest),
            nativeOnly: nativeOnly(manifest),
          },
        ];
      }),
  );

const run = (command: string, args: readonly string[], cwd: string): string =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The runtimes a consumer imports with; `bun` for the packages that declare only `engines.bun`. */
type Runtime = "node" | "bun";

const EVAL = {
  node: ["--input-type=module", "-e"],
  bun: ["-e"],
} as const satisfies Record<Runtime, readonly string[]>;

/** Runs `script` as an ES module in a fresh process of `runtime`; the failure text is the finding. */
const evaluate = (runtime: Runtime, cwd: string, script: string): string | undefined => {
  const result = spawnSync(runtime, [...EVAL[runtime], script], { cwd, encoding: "utf8" });
  return result.status === 0 ? undefined : (result.stderr || result.stdout).trim();
};

/**
 * One step of the durable round trip, as a script for a fresh process.
 *
 * The mesh opens with `sqlite({ dir })` and no driver, so the client picks the platform's default
 * store itself: `@syncmesh/sqlite-node` under Node, `@syncmesh/sqlite-bun` under Bun, each
 * resolved from the installed tarball. `adapter` is imported by name as well, so a package whose
 * own entry does not load fails here and not only through the client's dynamic import.
 *
 * - `write` writes one row and stops the mesh.
 * - `reopen` opens the same directory in a new process and reads the row back, then writes
 *   another: the state file and the log both survived the process.
 * - `refold` deletes the state files first, so the rows can only come back from the durable log.
 */
const durableStep = (adapter: string, step: "write" | "reopen" | "refold") => `
  await import(${JSON.stringify(adapter)});
  const { readdirSync, rmSync } = await import("node:fs");
  const { sqlite } = await import("@syncmesh/client");
  // the subpath too: an exports entry Node cannot resolve is exactly what Bun would forgive
  const { createMesh } = await import("@syncmesh/client/internal");
  const { syncSchema, t } = await import("@syncmesh/schema");
  const { createIdentity } = await import("@syncmesh/wire");
  const { sqliteTable, text } = await import("drizzle-orm/sqlite-core");
  const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
  const schema = syncSchema({ tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } } });
  const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
  const step = ${JSON.stringify(step)};
  if (step === "refold") {
    const states = readdirSync("./data").filter((file) => file.includes(".state@"));
    if (states.length === 0) throw new Error("no state file beside the log: " + readdirSync("./data").join(", "));
    for (const file of states) rmSync("./data/" + file);
  }
  const mesh = (
    await createMesh({ schema, identity, storage: sqlite({ dir: "./data" }), trust: { authority: identity.peerId } })
  ).unwrap();
  const { db } = mesh.on().unwrap();
  const held = async () => (await db.select().from(notes)).map((row) => row.id).sort().join(",");
  const want = { write: "", reopen: "n1", refold: "n1,n2" }[step];
  if ((await held()) !== want) throw new Error(step + ": found [" + (await held()) + "], wanted [" + want + "]");
  if (step === "write") await db.insert(notes).values({ id: "n1", body: "from " + ${JSON.stringify(adapter)} });
  if (step === "reopen") await db.insert(notes).values({ id: "n2", body: "after a reopen" });
  const after = { write: "n1", reopen: "n1,n2", refold: "n1,n2" }[step];
  if ((await held()) !== after) throw new Error(step + ": the write did not come back");
  await mesh.stop();
`;

/** The durable round trip under one runtime, each step in its own process over one directory. */
const durableRoundTrip = (
  runtime: Runtime,
  adapter: string,
  project: string,
): string | undefined => {
  const dir = mkdtempSync(join(project, `durable-${runtime}-`));
  try {
    for (const step of ["write", "reopen", "refold"] as const) {
      const failure = evaluate(runtime, dir, durableStep(adapter, step));
      if (failure !== undefined) return `${step}: ${failure}`;
    }
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Which adapter each runtime's default store is, and so which one its round trip proves. */
const DEFAULT_STORE = {
  node: "@syncmesh/sqlite-node",
  bun: "@syncmesh/sqlite-bun",
} as const satisfies Record<Runtime, string>;

function main(): number {
  const packages = publishable();
  const work = mkdtempSync(join(tmpdir(), "syncmesh-consumer-"));
  const tarballs = join(work, "tarballs");
  const project = join(work, "project");
  mkdirSync(tarballs);
  mkdirSync(project);
  const failures: string[] = [];
  try {
    for (const { name, dir } of packages) {
      run("bun", ["pm", "pack", "--quiet", "--destination", tarballs], dir);
      process.stdout.write(`packed   ${name}\n`);
    }
    const files = readdirSync(tarballs).filter((f) => f.endsWith(".tgz"));
    const specs = Object.fromEntries(
      packages.map(({ name }) => {
        const file = files.find((f) => f.startsWith(name.replace("@", "").replace("/", "-")));
        if (file === undefined) throw new Error(`no tarball for ${name}`);
        return [name, `file:${join(tarballs, file)}`];
      }),
    );
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify(
        {
          name: "consumer",
          private: true,
          type: "module",
          // the peers an app supplies: drizzle-orm for the client, react for the hooks, Loro for
          // the loro@1 adapter
          dependencies: {
            ...specs,
            "drizzle-orm": "1.0.0-rc.4",
            "loro-crdt": "1.17.1",
            react: "^19",
            "react-dom": "^19",
          },
          overrides: specs,
        },
        null,
        2,
      ),
    );
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], project);
    process.stdout.write(
      `installed ${packages.length} tarballs with npm ${run("npm", ["--version"], project).trim()} under node ${process.version}\n`,
    );

    for (const { name, bunOnly: onBun, nativeOnly: onNative } of packages) {
      if (onNative) {
        process.stdout.write(`rn-only  ${name} (installed, not imported: a React Native peer)\n`);
        continue;
      }
      // a package that declares only `engines.bun` is imported with bun, from the same install
      const runtime = onBun ? "bun" : "node";
      const failure = evaluate(runtime, project, `await import(${JSON.stringify(name)})`);
      process.stdout.write(
        `${failure === undefined ? "imports " : "FAILS   "} ${name} (${runtime})\n`,
      );
      if (failure !== undefined) failures.push(`${name} (${runtime})\n${failure}`);
    }
    for (const runtime of ["node", "bun"] as const) {
      const adapter = DEFAULT_STORE[runtime];
      const failure = durableRoundTrip(runtime, adapter, project);
      process.stdout.write(
        `${failure === undefined ? "durable " : "FAILS   "} ${adapter} (${runtime}): write, reopen, refold from the log\n`,
      );
      if (failure !== undefined)
        failures.push(`${adapter} durable round trip (${runtime})\n${failure}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    process.stderr.write(`\n${failures.join("\n\n")}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
