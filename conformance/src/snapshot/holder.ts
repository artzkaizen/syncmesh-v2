/** The snapshot vectors' holder (gap U31): who signs, what it folds, and the frames it serves. */
import type { Engine, EventStore, Interest } from "@syncmesh/engine";
import type { DocColumns, PeerId, SeqNum } from "@syncmesh/kernel";

import { snapshotHash } from "@syncmesh/docs";
import {
  createEngine,
  createMemoryEventStore,
  createMemoryStateStore,
  createValidator,
} from "@syncmesh/engine";
import { createHlcClock, hlcOf, parseAdapterId } from "@syncmesh/kernel";
import { flat, local, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  createJoinExchange,
  decodeFrame,
  snapChunkFrame,
  snapManifestFrame,
  type SnapshotDocs,
} from "@syncmesh/transport";
import {
  bytesToHex,
  checkpointHash,
  createIdentity,
  decodeAndVerify,
  decodeCbor,
  encodeCbor,
  encodeRecord,
  hexToBytes,
  issueCheckpoint,
  signCheckpoint,
  type CborValue,
  type Identity,
} from "@syncmesh/wire";

import { resignedAsVersion } from "../checkpoint-version.js";
import { cells, createAuthors, insert, remove, update } from "../policy/changes.js";
import { ACME, BETA, NOW, NOW_MS, column, key, procedure, table } from "../policy/schema.js";

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
 * A holder whose one row's cells were not first written in column order (`body` after `id` and
 * `title`). A record is encoded and hashed with its cells in column order whatever order they
 * were written in (gaps U34), so a holder in either runtime serves this row as the same bytes.
 */
export function unsortedHistory(): readonly string[] {
  const { sign } = createAuthors();
  const at = (n: number) => ({ partition: ACME, atMs: NOW_MS - 60_000 + n });
  return [
    sign(A, [insert("notes", "u1", { title: "zed" })], at(1)),
    sign(A, [update("notes", "u1", { body: "abc" })], at(2)),
  ];
}

/**
 * The schema the `local` holder runs (gaps U36): `notes` syncs in an `org`, `drafts` is the
 * `local` kind, whose rows never leave the device that wrote them.
 */
export const SNAPSHOT_SCHEMA = syncSchema({
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text().nullable(), body: t.text().nullable() },
      partition: partition("org", { roles: flat("member") }),
      allow: ({ allow }) => ({ $default: allow }),
    },
    drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: local },
  },
});

export const engineFor = (
  peerId: PeerId,
  options: {
    readonly docs?: DocColumns | undefined;
    readonly store?: EventStore;
    readonly local?: boolean;
  } = {},
) =>
  createEngine({
    peerId,
    clock: createHlcClock({ now: () => NOW }),
    store: options.store ?? createMemoryEventStore(),
    ...(options.docs !== undefined && { docs: options.docs }),
    // the joiner keeps its rows in a state store, so an install records its floor in the log
    ...(options.store !== undefined && { stateStore: createMemoryStateStore() }),
    ...(options.local === true && {
      validate: createValidator({ schema: SNAPSHOT_SCHEMA, grantFor: null }),
    }),
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

/** The draft the `local` holder writes to its `local` table before it serves. */
export const DRAFT = { id: "d1", body: "mine" } as const;

async function holderWith(
  certificate: number | undefined,
  events: readonly string[],
  drafts: boolean,
) {
  const engine = engineFor(HOLDER.peerId, { local: drafts });
  const entries = events.map((hex) => decodeAndVerify(hexToBytes(hex).unwrap()).unwrap());
  const received = (await engine.receiveBatch(entries)).unwrap();
  if (received.folded !== entries.length) throw new Error("the holder folds every event");
  if (drafts) {
    const wrote = await engine.mutate(
      procedure("drafts.create"),
      (tx) => tx.insert(table("drafts"), key(DRAFT.id), cells(DRAFT)),
      { local: true },
    );
    wrote.unwrap();
  }
  const cert = certificate === undefined ? undefined : certificateFor(engine, certificate);
  return { engine, cert };
}

/**
 * What the holder sends for one request. `drafts`: the holder runs {@link SNAPSHOT_SCHEMA} and has
 * written {@link DRAFT} to its `local` table, which the frames must leave out (gaps U36).
 */
export async function serve(
  interest: Interest | undefined,
  certificate?: number,
  events: readonly string[] = history(),
  drafts = false,
  docs?: SnapshotDocs,
) {
  const { engine, cert } = await holderWith(certificate, events, drafts);
  const out = collector();
  const exchange = createJoinExchange({
    engine,
    send: out.send,
    idPrefix: "holder",
    rowsPerChunk: ROWS_PER_CHUNK,
    ...(cert !== undefined && { certificate: () => cert }),
    ...(docs !== undefined && { docs }),
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

/** The frames as hex, decoded. */
const decoded = (frames: readonly string[]) =>
  frames.map((hex) => decodeFrame(hexToBytes(hex).unwrap()).unwrap());

/** A decoded CBOR value read as an array, or a throw: the generator's pages are its own. */
const fields = (value: CborValue | undefined, what: string): readonly CborValue[] => {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  // SAFETY: an array the CBOR decoder built holds only decoded CBOR values
  return value as readonly CborValue[];
};

/** A page's row `[table, key, write, delete, partition, cells]` with its cells reversed. */
const reversedCells = (row: CborValue): CborValue => {
  const parts = fields(row, "a row");
  return [...parts.slice(0, 5), [...fields(parts[5], "a row's cells")].reverse()];
};

/**
 * `frames` as a holder built before gaps U34 serves them: each page's rows with their cells in
 * reverse column order. The rows and the certificate are unchanged.
 */
export function outOfColumnOrder(frames: readonly string[]): readonly string[] {
  return decoded(frames).map((frame, i) => {
    if (frame.kind !== "snap-chunk") return frames[i] ?? "";
    const page = fields(decodeCbor(frame.bytes).unwrap(), "a page");
    const rows = fields(page[4], "a page's rows").map(reversedCells);
    const bytes = encodeCbor([...page.slice(0, 4), rows]);
    return bytesToHex(snapChunkFrame(frame.id, frame.index, bytes));
  });
}

/** `frames` with the manifest's certificate re-signed by the issuer as `version`. */
export function certifiedAs(frames: readonly string[], version: number): readonly string[] {
  return decoded(frames).map((frame, i) => {
    if (frame.kind !== "snap-manifest" || frame.certificate === undefined) return frames[i] ?? "";
    const older = resignedAsVersion(ISSUER, frame.certificate, version);
    return bytesToHex(
      snapManifestFrame(frame.id, frame.chunks, frame.rows, frame.at, frame.scope, older),
    );
  });
}

/**
 * The documents a holder with a document runtime serves beside its rows (RFC-0023 §5.5, E30 P5):
 * for each row of a page, a checkpoint {@link ISSUER} signed of its `content` column, naming
 * snapshot bytes that spell the row's key. A page holding a tombstone says it is not complete and
 * every other page says it is, so the frozen pages hold both.
 */
export const DOCUMENTED: SnapshotDocs = {
  serve: (rows) =>
    Promise.resolve({
      checkpoints: rows.map(({ table: at, key: row }) => {
        const snapshot = new TextEncoder().encode(String(row));
        const signed = signCheckpoint(
          {
            table: at,
            key: row,
            column: column("content"),
            adapter: parseAdapterId("loro@1").unwrap(),
            covers: new Map(),
            version: Uint8Array.of(0x01),
            snapshot: { hash: snapshotHash(snapshot), size: snapshot.length },
            derived: new Map(),
            at: hlcOf(NOW_MS, 0),
          },
          ISSUER,
        );
        return { producer: ISSUER.peerId, checkpoint: signed.wire, snapshot };
      }),
      complete: rows.every(({ record }) => record.deleteStamp === undefined),
    }),
  install: () => Promise.resolve(false),
};
