/**
 * The TypeScript half of the Rust peer link's acceptance test
 * (`crates/syncmesh-client/tests/peer_interop.rs`, gap U3's radios): one TypeScript device a Rust
 * device links to directly, with no relay between them.
 *
 * `bun run conformance/src/interop/peer-device.ts lan` runs the real LAN transport over Node's
 * sockets (`@syncmesh/transports`' `lan` on `@syncmesh/lan-node`), multicast off, accepting on a
 * loopback port: the Rust device dials it and the two speak the length-framed sealed link the LAN
 * transport always speaks. `… ble` runs the real BLE link (`@syncmesh/ble`'s `bleLink`, its
 * fragments and reassembly) as the peripheral, its characteristic carried over a loopback socket
 * one length-prefixed packet at a time — what a GATT write is — and upgraded as a frame medium.
 *
 * Prints one JSON line saying where, then takes JSON commands on stdin:
 *
 * - `{"write":{"key","body"}}` writes a note and answers `{"wrote": id}`;
 * - `{"presence":{"topic","partition","x"}}` publishes this device's value at a topic;
 * - `{"snapshot":true}` asks the linked peer for state, and `{"snapshot":{...}}` says how it ended;
 * - `{"quit":true}` stops everything.
 *
 * and prints `{"folded":[[table, key, row]...]}` for every remote fold, `{"presence":{...}}` for
 * every value that arrives, and `{"link":{...}}` for every link event (proved, closed, refused).
 * No validator, as in `relay-peer.ts`: this measures the wire.
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
import type { ByteStream, Transport, TransportContext } from "@syncmesh/transport";

import { bleLink, bytesToBase64 } from "@syncmesh/ble";
import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { nodeLan } from "@syncmesh/lan-node";
import { Result, omitUndefined } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { createFrameTransport, framed } from "@syncmesh/transport";
import { lan } from "@syncmesh/transports";
import {
  createGrantRegistry,
  createIdentity,
  decodeAndVerifyPresence,
  signPresence,
} from "@syncmesh/wire";
import { createServer, type AddressInfo, type Socket } from "node:net";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- an interop script's fixed names */
const NOTES = "notes" as TableName;
const BODY = "body" as ColumnName;
const CREATE = "notes.create" as Procedure;
const X = "x" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** What one BLE write carries in this test: small, so a frame always takes several. */
const BLE_LIMIT = 64;

type FoldedRow = readonly [TableName, RowKey, Readonly<Record<string, CellValue>> | null];

type Said =
  | { readonly ready: true; readonly port: number; readonly tsPeer: PeerId }
  | { readonly folded: readonly FoldedRow[] }
  | { readonly wrote: EventId }
  | { readonly presence: { readonly peer: PeerId; readonly topic: string; readonly x: unknown } }
  | { readonly snapshot: { readonly rows: number; readonly provisional: boolean } }
  | { readonly link: { readonly kind: string; readonly peer?: PeerId; readonly why?: string } }
  | { readonly error: string };

const print = (line: Said): void => {
  console.log(JSON.stringify(line));
};

const medium = process.argv[2] ?? "lan";
const identity = createIdentity(seed(17)).unwrap();
const now = () => Temporal.Now.instant();
const engine = createEngine({
  peerId: identity.peerId,
  clock: createHlcClock({ now }),
  store: createMemoryEventStore(),
});
const grants = createGrantRegistry({ issuer: identity.peerId, now });
const session = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
let presenceCount = 0;

/**
 * A socket as the stream the upgrader reads: what arrives before anyone listens is held, because
 * the far side's hello is already on its way when the connection is accepted.
 */
const socketStream = (socket: Socket): ByteStream => {
  const held: Uint8Array[] = [];
  const readers = new Set<(bytes: Uint8Array) => void>();
  const closes = new Set<() => void>();
  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (readers.size === 0) held.push(bytes);
    for (const cb of readers) cb(bytes);
  });
  socket.on("close", () => {
    for (const cb of closes) cb();
  });
  socket.on("error", () => socket.destroy());
  return {
    write: (bytes) => {
      if (socket.destroyed || !socket.writable) throw new Error("the socket is closed");
      socket.write(bytes);
    },
    onData: (cb) => {
      readers.add(cb);
      // after the caller's own wiring, which attaches its frame listener once this returns
      queueMicrotask(() => {
        for (const bytes of held.splice(0)) cb(bytes);
      });
      return () => void readers.delete(cb);
    },
    onClose: (cb) => {
      closes.add(cb);
      return () => void closes.delete(cb);
    },
    close: () => socket.destroy(),
  };
};

/**
 * The BLE link as the peripheral holds it, its characteristic carried over a socket: every packet
 * one length-prefixed record, which is what a GATT write or notification is — one bounded value.
 */
const createBleLink = (
  socket: Socket,
  report: (why: string) => void,
): ReturnType<typeof bleLink> => {
  const packets = framed(socketStream(socket), { onDropped: report });
  const link = bleLink({
    radio: {
      write: async () => undefined,
      setCharacteristicValue: async (_service, _characteristic, value) => {
        packets.send(Uint8Array.from(Buffer.from(value, "base64")));
      },
      disconnect: async () => undefined,
    },
    serviceUuid: "interop",
    characteristicUuid: "interop",
    peer: "rust",
    limit: () => BLE_LIMIT,
    onDropped: report,
  });
  packets.onFrame((packet) => link.accept(bytesToBase64(packet)));
  return link;
};

const listenOn = async (accept: (socket: Socket) => void): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer(accept);
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP listener reports an `AddressInfo`; the string form is a unix socket's
      resolve((server.address() as AddressInfo).port);
    });
  });

const report = (why: string): void => print({ link: { kind: "dropped", why } });

/** The transport under test, and the loopback port the Rust device dials. */
const opened = async (): Promise<{ readonly transport: Transport; readonly port: number }> => {
  if (medium === "ble") {
    const accepted: Socket[] = [];
    let upgradeOne = (socket: Socket): void => void accepted.push(socket);
    const port = await listenOn((socket) => upgradeOne(socket));
    const transport = createFrameTransport({
      name: "ble",
      kind: "ble",
      open: (_ctx, _attach, upgrade) => {
        upgradeOne = (socket) =>
          void upgrade.frames(createBleLink(socket, report), {
            onClosed: (why) => print({ link: { kind: "closed", why } }),
          });
        for (const socket of accepted.splice(0)) upgradeOne(socket);
      },
    });
    return { transport, port };
  }
  const network = (
    await nodeLan({ multicast: false, host: "127.0.0.1", discoveryPort: 0, onDropped: report })
  ).unwrap();
  const transport = lan({ id: "interop", network, onDropped: report });
  return { transport, port: network.address().port };
};

const { transport, port } = await opened();
const context: TransportContext = {
  engine,
  identity,
  grants,
  now,
  onPresence: (wire) => {
    const verified = decodeAndVerifyPresence(wire);
    if (verified.isErr()) return print({ error: verified.error.message });
    const { peerId, topic, value } = verified.value.presence;
    print({ presence: { peer: peerId, topic, x: value?.get(X) ?? null } });
  },
  onSnapshot: (installed) =>
    print({ snapshot: { rows: installed.rows, provisional: installed.provisional } }),
};

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

transport.onLinkEvent?.(({ kind, peer, why }) =>
  print({ link: omitUndefined({ kind, peer, why }) }),
);
await transport.start(context);
print({ ready: true, port, tsPeer: identity.peerId });

interface Command {
  readonly write?: { readonly key: string; readonly body: string };
  readonly presence?: { readonly topic: string; readonly partition: string; readonly x: number };
  readonly snapshot?: boolean;
  readonly quit?: boolean;
}

for await (const line of console) {
  if (line.trim() === "") continue;
  const parsed = Result.try(
    // SAFETY: stdin is written only by crates/syncmesh-client/tests/peer_interop.rs, which sends
    // the `Command` shapes and nothing else
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
  if (command.presence !== undefined) {
    const { topic, partition, x } = command.presence;
    presenceCount += 1;
    const signed = signPresence(
      {
        v: 1,
        peerId: identity.peerId,
        topic,
        partition: parsePartitionKey(partition).unwrap(),
        session,
        count: presenceCount,
        value: new Map([[X, x]]),
        expires: now().epochMilliseconds + 60_000,
      },
      identity,
    );
    transport.sendPresence?.(signed.wire);
  }
  if (command.snapshot === true) transport.requestSnapshot?.(undefined, true);
  if (command.quit === true) {
    await transport.stop();
    process.exit(0);
  }
}
