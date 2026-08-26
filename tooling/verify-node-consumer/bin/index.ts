#!/usr/bin/env node

/**
 * The consumer check the test suite cannot give us: Bun runs every test, and Bun tolerates what
 * Node rejects — extensionless imports, `bun:*` at the top level, a missing `exports` entry.
 * So: pack what would ship, install the tarballs into an empty project, and `import()` each
 * package with real `node`. The client gets one step more: open a mesh with no `store` so the
 * platform default resolves to the node adapter on Node.
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
}

interface Publishable {
  readonly name: string;
  readonly dir: string;
  /** Declares `engines.bun` and not `engines.node`: installable everywhere, importable only on Bun. */
  readonly bunOnly: boolean;
}

const bunOnly = (manifest: Manifest): boolean =>
  manifest.engines?.bun !== undefined && manifest.engines.node === undefined;

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
        return [{ name: manifest.name, dir, bunOnly: bunOnly(manifest) }];
      }),
  );

const run = (command: string, args: readonly string[], cwd: string): string =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** `import()` in a fresh node process; the failure text is the finding. */
const importWithNode = (cwd: string, script: string): string | undefined => {
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0 ? undefined : (result.stderr || result.stdout).trim();
};

const clientSmoke = `
  const { createMesh } = await import("@syncmesh/client");
  const { defineSchema, t } = await import("@syncmesh/schema");
  const { createIdentity } = await import("@syncmesh/wire");
  const { sqliteTable, text } = await import("drizzle-orm/sqlite-core");
  const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
  const schema = defineSchema({ tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } } });
  const identity = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
  const mesh = (await createMesh({ schema, identity, authority: identity.peerId, dataDir: "./data" })).unwrap();
  const { db } = mesh.on().unwrap();
  await db.insert(notes).values({ id: "n1", body: "from node" });
  if ((await db.select().from(notes)).length !== 1) throw new Error("the row did not come back");
  await mesh.stop();
`;

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
          // the peers an app supplies: drizzle-orm for the client, react for the hooks
          dependencies: { ...specs, "drizzle-orm": "latest", react: "^19", "react-dom": "^19" },
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

    for (const { name, bunOnly: skip } of packages) {
      if (skip) {
        process.stdout.write(`bun-only ${name} (installed, not imported: engines.bun)\n`);
        continue;
      }
      const failure = importWithNode(project, `await import(${JSON.stringify(name)})`);
      process.stdout.write(`${failure === undefined ? "imports " : "FAILS   "} ${name}\n`);
      if (failure !== undefined) failures.push(`${name}\n${failure}`);
    }
    const smoke = importWithNode(project, clientSmoke);
    process.stdout.write(
      `${smoke === undefined ? "runs    " : "FAILS   "} @syncmesh/client: durable mesh over node:sqlite\n`,
    );
    if (smoke !== undefined) failures.push(`client smoke\n${smoke}`);
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
