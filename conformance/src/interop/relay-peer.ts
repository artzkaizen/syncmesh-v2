/**
 * The TypeScript half of the Rust client's acceptance test (`crates/syncmesh-client/tests/interop.rs`).
 *
 * Starts a real relay over Bun's WebSocket server and one TypeScript peer joined to its `interop`
 * room, prints one JSON line saying where, then takes JSON commands on stdin — `{"write":{...}}`
 * makes a write and answers `{"wrote": id}`; `{"quit":true}` stops everything — and prints
 * `{"folded":[[table, key, row]...]}` for every remote fold. Everything the Rust device does is
 * measured against what this process sees: a row the Rust device wrote has to come out of this
 * engine, byte for byte through the same relay a TypeScript device would use.
 *
 * No validator on purpose: this measures the wire, and a test that admits on one side and refuses
 * on the other would be testing the ladder. The ladder is measured on its own, in both runtimes,
 * against `conformance/policy-vectors.json` (gap U3).
 */
import type { FoldBatch } from "@syncmesh/engine";
import type {
  CellValue,
  ColumnName,
  EventId,
  PeerId,
  Procedure,
  RowKey,
  TableName,
} from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, readRow } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, createIdentity } from "@syncmesh/wire";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- an interop script's fixed names */
const NOTES = "notes" as TableName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** One folded row as the Rust test reads it: table, key, and the row's cells or `null`. */
type FoldedRow = readonly [TableName, RowKey, Readonly<Record<string, CellValue>> | null];

/** Every line this process prints on stdout. */
type Said =
  | { readonly ready: true; readonly url: string; readonly peerId: PeerId; readonly tsPeer: PeerId }
  | { readonly folded: readonly FoldedRow[] }
  | { readonly wrote: EventId }
  | { readonly error: string };

const print = (line: Said): void => {
  console.log(JSON.stringify(line));
};

const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-interop-"));
const relay = await startRelay(0, { dataDir, keepaliveMs: 1000, pageSize: 2 });
const identity = createIdentity(seed(7)).unwrap();
const now = () => Temporal.Now.instant();
const engine = createEngine({
  peerId: identity.peerId,
  clock: createHlcClock({ now }),
  store: createMemoryEventStore(),
});
const grants = createGrantRegistry({ issuer: identity.peerId, now });
const transport = relayTransport({
  dial: webSocketDial(`${relay.url}/interop`),
  relayKey: relay.peerId,
  reconnectMs: 50,
});
const context: TransportContext = { engine, identity, grants, now };

engine.onFoldBatch((batch: FoldBatch) => {
  if (batch.source !== "remote") return;
  const rows: FoldedRow[] = [];
  for (const [table, keys] of batch.writeKeys) {
    for (const key of keys) {
      const row = readRow(engine.state(), table, key);
      rows.push([table, key, row === undefined ? null : Object.fromEntries(row)]);
    }
  }
  print({ folded: rows });
});

await transport.start(context);
print({ ready: true, url: relay.url, peerId: relay.peerId, tsPeer: identity.peerId });

interface Command {
  readonly write?: { readonly key: string; readonly body: string };
  readonly quit?: boolean;
}

for await (const line of console) {
  if (line.trim() === "") continue;
  const parsed = Result.try(
    // SAFETY: stdin is written only by crates/syncmesh-client/tests/interop.rs, which sends the
    // two `Command` shapes and nothing else
    () => JSON.parse(line) as Command,
  );
  if (parsed.isErr()) {
    print({ error: `not json: ${line}` });
    continue;
  }
  const command = parsed.value;
  if (command.write !== undefined) {
    const { key, body } = command.write;
    const written = await engine.mutate(CREATE, (tx) =>
      // SAFETY: a row key is any string the writer names, and this one is the Rust test's
      tx.insert(NOTES, key as RowKey, new Map([[BODY, body]])),
    );
    written.match({
      ok: (event) => print({ wrote: event.id }),
      err: (failure) => print({ error: failure.message }),
    });
  }
  if (command.quit === true) {
    await transport.stop();
    await relay.stop();
    process.exit(0);
  }
}
