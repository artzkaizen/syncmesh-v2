import { append, oplog, values, type OpLog } from "@syncmesh/docs/testing";
import { createLink } from "@syncmesh/engine";
import { parsePartitionKey, type Procedure, type RowKey } from "@syncmesh/kernel";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { drizzleTable, from, partition, syncSchema, type DocumentAdapter } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { isBlobHash, sqlBlobStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { blob, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";
import { sqlite } from "../options.js";

const notes = sqliteTable("notes", {
  id: text().primaryKey(),
  title: text().notNull().default(""),
  content: blob({ mode: "buffer" }),
});
const workspace = partition("workspace");
/** The column's declaration: the adapter's wire id, and the document type a derive reads. */
const OPLOG_COLUMN = { id: "oplog@1" } satisfies DocumentAdapter<OpLog>;
const schema = () =>
  syncSchema({
    tables: {
      notes: drizzleTable(notes, {
        partition: workspace,
        merge: { content: OPLOG_COLUMN },
        derive: { title: from("content", (doc: OpLog) => values(doc).join(" ")) },
        allow: ({ allow }) => ({ $default: allow }),
      }),
    },
  });
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture names; naming rules are not under test */
const N1 = "n1" as RowKey;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const W1 = parsePartitionKey("workspace:w1").unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const FAST = {
  idle: Temporal.Duration.from({ milliseconds: 5 }),
  max: Temporal.Duration.from({ milliseconds: 20 }),
};

const open = async (
  n: number,
  documents = true,
  withBlobs = false,
  transports: Parameters<typeof createMesh>[0]["transports"] = [],
) => {
  let ms = T0.epochMilliseconds + n;
  const driver = bunSqliteDriver(":memory:");
  const blobs = withBlobs ? (await sqlBlobStore(driver)).unwrap() : undefined;
  return (
    await createMesh({
      schema: schema(),
      identity: createIdentity(Uint8Array.from({ length: 32 }, (_, i) => n + i)).unwrap(),
      now: () => Temporal.Instant.fromEpochMilliseconds((ms += 1)),
      storage: sqlite({ driver, ...(blobs !== undefined && { blobs }) }),
      ...(documents && { documents: { adapters: [oplog()], pacing: FAST } }),
      transports,
    })
  ).unwrap();
};

const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return check();
};

describe("documents through a mesh (RFC-0023 §4.3)", () => {
  test("two meshes type into one note, each reads the other, and the derived title follows", async () => {
    const a = await open(40);
    const b = await open(90);
    const { name: table, columnNames } = schema().tables.notes;
    const address = { table, key: N1, column: columnNames.content };
    const link = createLink(a.engine, b.engine);
    (
      await a.engine.mutate(
        CREATE,
        (tx) => tx.insert(table, address.key, new Map([[columnNames.id, "n1"]])),
        { partition: W1 },
      )
    ).unwrap();
    const onA = (await a.docs?.open<OpLog>(address))?.unwrap();
    append(onA?.value ?? panicked(), "hello");
    (await onA?.flush())?.unwrap();
    await link.flush();

    const onB = (await b.docs?.open<OpLog>(address))?.unwrap();
    expect(values(onB?.value ?? panicked())).toEqual(["hello"]);
    const title = async (mesh: typeof a) =>
      (await mesh.query?.("SELECT title FROM notes WHERE id = 'n1'"))?.[0]?.[0];
    expect(await until(async () => (await title(b)) === "hello")).toBe(true);

    append(onB?.value ?? panicked(), "world");
    (await onB?.flush())?.unwrap();
    await link.flush();
    expect(await until(() => values(onA?.value ?? panicked()).length === 2)).toBe(true);
    expect(values(onA?.value ?? panicked())).toEqual(values(onB?.value ?? panicked()));
    expect(await until(async () => (await title(a)) === (await title(b)))).toBe(true);

    // an edit still waiting on its pacing is sent by stop, not lost with the process
    append(onB?.value ?? panicked(), "last");
    const logged = (await b.engine.docLog()).unwrap().length;
    await b.stop();
    await link.flush();
    expect(await until(() => values(onA?.value ?? panicked()).includes("last"))).toBe(true);
    expect(logged).toBe(2);
    link.close();
    await a.stop();
  });

  test("mesh.docs writes a row and its document in one event, and a large burst rides mesh.blobs", async () => {
    const a = await open(42, true, true);
    const { name: table, columnNames } = schema().tables.notes;
    const address = { table, key: N1, column: columnNames.content };
    const docs = a.docs ?? panicked();
    const event = (
      await docs.mutate(
        CREATE,
        (tx, writes) => {
          tx.insert(table, address.key, new Map([[columnNames.id, "n1"]]));
          writes.change<OpLog>(address, (doc) => append(doc, "first"));
        },
        { partition: W1 },
      )
    ).unwrap();
    expect(event.changes.map((c) => c.kind)).toEqual(["insert", "doc"]);
    const title = await a.query?.("SELECT title FROM notes WHERE id = 'n1'");
    expect(title?.[0]?.[0]).toBe("first");

    const pasted = "p".repeat(70 * 1024); // past the 64 KiB inline bound
    const big = (
      await docs.mutate(CREATE, (_tx, writes) =>
        writes.change<OpLog>(address, (doc) => append(doc, pasted)),
      )
    ).unwrap();
    const change = big.changes[0];
    const ref = change?.kind === "doc" ? change.update.blob : undefined;
    expect(ref?.size).toBeGreaterThan(64 * 1024);
    expect(await a.blobs.has(parseBlobHash(ref?.hash))).toBe(true);
    await a.stop();
  });

  test("a burst put offline reaches a peer once the author has a carrier", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-docblobs-"));
    const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000 });
    const carrier = () => relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
    try {
      const a = await open(44, true, true);
      const { name: table, columnNames } = schema().tables.notes;
      const address = { table, key: N1, column: columnNames.content };
      const pasted = "q".repeat(70 * 1024); // past the 64 KiB inline bound
      (
        await (a.docs ?? panicked()).mutate(
          CREATE,
          (tx, writes) => {
            tx.insert(table, address.key, new Map([[columnNames.id, "n1"]]));
            writes.change<OpLog>(address, (doc) => append(doc, pasted));
          },
          { partition: W1 },
        )
      ).unwrap();
      // no transport at all: the bytes stay here, and nothing refused the write
      (await a.transports.add(carrier())).unwrap();
      const b = await open(94, true, true, [carrier()]);
      const docs = b.docs ?? panicked();
      const reads = async () => {
        const doc = (await docs.open<OpLog>(address)).unwrap();
        const read = values(doc.value);
        (await doc.close()).unwrap();
        return read;
      };
      expect(await until(async () => (await reads())[0] === pasted, 8000)).toBe(true);
      await a.stop();
      await b.stop();
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("without `documents` a mesh folds and keeps the column, and has no runtime to open it", async () => {
    const a = await open(41);
    const relay = await open(91, false);
    expect(relay.docs).toBeUndefined();
    const { name: table, columnNames } = schema().tables.notes;
    const address = { table, key: N1, column: columnNames.content };
    (
      await a.engine.mutate(
        CREATE,
        (tx) => tx.insert(table, address.key, new Map([[columnNames.id, "n1"]])),
        { partition: W1 },
      )
    ).unwrap();
    const doc = (await a.docs?.open<OpLog>(address))?.unwrap();
    append(doc?.value ?? panicked(), "carried");
    (await doc?.flush())?.unwrap();
    // the device with the adapter labels its own entry `tail`, so it can open and materialise it
    expect((await a.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["tail"]);
    const link = createLink(a.engine, relay.engine);
    (await link.catchUp()).unwrap();
    expect((await relay.engine.docLog()).unwrap().map((e) => e.state)).toEqual(["adapter-missing"]);
    link.close();
    await a.stop();
    await relay.stop();
  });
});

/** The hash a change names, as the store keys it. */
function parseBlobHash(hash: string | undefined) {
  if (hash === undefined || !isBlobHash(hash)) throw new Error("the change names a blob");
  return hash;
}

function panicked(): never {
  throw new Error("the mesh was opened with documents, so it has a runtime");
}
