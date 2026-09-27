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
 * No validator on purpose: the Rust client has no policy ladder yet (D37), and a test that admits
 * on one side and refuses on the other would be testing the ladder, not the wire.
 */
import type { FoldBatch } from "@syncmesh/engine";
import type { ColumnName, Procedure, RowKey, TableName } from "@syncmesh/kernel";
import type { TransportContext } from "@syncmesh/transport";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, readRow } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
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

const print = (line: unknown): void => {
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
  const rows: unknown[] = [];
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
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch {
    print({ error: `not json: ${line}` });
    continue;
  }
  if (command.write !== undefined) {
    const { key, body } = command.write;
    const written = await engine.mutate(CREATE, (tx) =>
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
