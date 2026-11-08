/** The snapshot vectors' holder (gap U31): who signs, what it folds, and the frames it serves. */
import type { Engine, Interest } from "@syncmesh/engine";
import type { DocColumns, PeerId, SeqNum } from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import { createHlcClock, parseAdapterId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { createJoinExchange, decodeFrame } from "@syncmesh/transport";
import {
  bytesToHex,
  checkpointHash,
  createIdentity,
  decodeAndVerify,
  encodeRecord,
  hexToBytes,
  issueCheckpoint,
  type Identity,
} from "@syncmesh/wire";

import { createAuthors, insert, remove, update } from "../policy/changes.js";
import { ACME, BETA, NOW, NOW_MS, column, table } from "../policy/schema.js";

const seed = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => (start + i * 7) % 256);
export const HOLDER = createIdentity(seed(3)).unwrap();
export const JOINER = createIdentity(seed(5)).unwrap();
export const ISSUER = createIdentity(seed(9)).unwrap();
const inIdOrder = (x: Identity, y: Identity): readonly [Identity, Identity] =>
  x.peerId < y.peerId ? [x, y] : [y, x];
/** The two authors, in id order. */
export const [A, B] = inIdOrder(
  createIdentity(seed(11)).unwrap(),
  createIdentity(seed(13)).unwrap(),
);

export const ROWS_PER_CHUNK = 2;
export const DOCS: DocColumns = new Map([
  [table("boards"), new Map([[column("content"), parseAdapterId("loro@1").unwrap()]])],
]);

/** The history the holder folds: inserts, a cell a later write moved, and a tombstone. */
export function history(): readonly string[] {
  const { sign } = createAuthors();
  const at = (n: number) => ({ partition: ACME, atMs: NOW_MS - 60_000 + n });
  return [
    sign(A, [insert("notes", "n1", { body: "first", title: "one" })], at(1)),
    sign(A, [insert("notes", "n2", { body: "second", title: "two" })], at(2)),
    sign(A, [update("notes", "n1", { body: "edited" })], at(3)),
    sign(B, [insert("notes", "n3", { body: "third", title: "three" })], at(4)),
    sign(B, [remove("notes", "n2")], at(5)),
    sign(B, [insert("notes", "n4", { body: "fourth", title: "four" })], {
      partition: BETA,
      atMs: NOW_MS - 60_000 + 6,
    }),
  ];
}

/**
 * A holder whose one row's cells are not in column order: the TypeScript keeps a record's cells
 * in the order they were first written (here `body` after `id` and `title`), and a certificate
 * hashes them in that order, so a port must hash a page's cells in the order they arrived.
 */
export function unsortedHistory(): readonly string[] {
  const { sign } = createAuthors();
  const at = (n: number) => ({ partition: ACME, atMs: NOW_MS - 60_000 + n });
  return [
    sign(A, [insert("notes", "u1", { title: "zed" })], at(1)),
    sign(A, [update("notes", "u1", { body: "abc" })], at(2)),
  ];
}

export const engineFor = (peerId: PeerId, docs?: DocColumns) =>
  createEngine({
    peerId,
    clock: createHlcClock({ now: () => NOW }),
    store: createMemoryEventStore(),
    ...(docs !== undefined && { docs }),
  });

export const pairs = (cursors: ReadonlyMap<PeerId, SeqNum> | undefined) =>
  [...(cursors ?? new Map<PeerId, SeqNum>())]
    .map(([peer, seq]) => [String(peer), Number(seq)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));

/** Every frame `send` was handed, as hex. */
export const collector = () => {
  const sent: string[] = [];
  return { sent, send: (_what: string, bytes: Uint8Array) => sent.push(bytesToHex(bytes)) };
};

/** The certificate over exactly the holder's rows, signing `coverage` for author A. */
const certificateFor = (holder: Engine, coverage: number) => {
  const rows = holder.snapshot().rows.map((row) => ({
    table: String(row.table),
    key: String(row.key),
    record: encodeRecord(row.record),
  }));
  return issueCheckpoint(ISSUER, {
    stateHash: checkpointHash(rows),
    coverage: new Map([[A.peerId, coverage]]),
    now: Temporal.Instant.fromEpochMilliseconds(NOW_MS),
  });
};

async function holderWith(certificate?: number, events: readonly string[] = history()) {
  const engine = engineFor(HOLDER.peerId);
  const entries = events.map((hex) => decodeAndVerify(hexToBytes(hex).unwrap()).unwrap());
  (await engine.receiveBatch(entries)).unwrap();
  const cert = certificate === undefined ? undefined : certificateFor(engine, certificate);
  return { engine, cert };
}

/** What the holder sends for one request. */
export async function serve(
  interest: Interest | undefined,
  certificate?: number,
  events: readonly string[] = history(),
) {
  const { engine, cert } = await holderWith(certificate, events);
  const out = collector();
  const exchange = createJoinExchange({
    engine,
    send: out.send,
    idPrefix: "holder",
    rowsPerChunk: ROWS_PER_CHUNK,
    ...(cert !== undefined && { certificate: () => cert }),
  });
  const ask = collector();
  createJoinExchange({ engine: engineFor(JOINER.peerId), send: ask.send, idPrefix: "x" }).request(
    interest,
  );
  const request = ask.sent[0] ?? "";
  const frame = decodeFrame(hexToBytes(request).unwrap()).unwrap();
  if (frame.kind !== "snap-req") throw new Error("expected a request");
  await exchange.dispatch(frame);
  return { request, frames: out.sent };
}
