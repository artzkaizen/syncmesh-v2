import type { Temporal } from "@syncmesh/temporal";

import { Result, TaggedError } from "@syncmesh/result";

import type { Lsn } from "./lsn.js";

import { lsnFrom } from "./lsn.js";

/**
 * The replication wire: the `CopyData` frames a walsender sends inside `START_REPLICATION`, and
 * the `pgoutput` messages (protocol version 1) inside them. Pure bytes in, plain data out — the
 * connection, the acks and the policy about what to do with each message live in
 * `replication.ts`.
 *
 * Reference: Postgres "Streaming Replication Protocol" and "Logical Replication Message
 * Formats".
 */

export class MalformedMessage extends TaggedError("MalformedMessage")<{
  tag: string;
  message: string;
  cause?: unknown;
}> {}

/** `REPLICA IDENTITY` as the relation message reports it. */
export type ReplicaIdentity = "default" | "nothing" | "full" | "index";

export interface RelationColumn {
  /** Part of the replica identity: sent in the old tuple of an update or delete. */
  readonly key: boolean;
  readonly name: string;
  readonly type: number;
  readonly typmod: number;
}

export interface Relation {
  readonly oid: number;
  readonly schema: string;
  readonly table: string;
  readonly identity: ReplicaIdentity;
  readonly columns: readonly RelationColumn[];
}

/**
 * One column of a tuple. `unchanged` is a TOASTed value the update did not touch: Postgres does
 * not send it, so it is absent rather than null.
 */
export type TupleCell =
  | { readonly kind: "null" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary"; readonly bytes: Uint8Array };

export type Tuple = readonly TupleCell[];

/** Which old row an update or delete carried: the identity columns only, or every column. */
export interface OldTuple {
  readonly kind: "key" | "full";
  readonly tuple: Tuple;
}

export type PgOutputMessage =
  /** `final` is the commit record's LSN; the transaction's end follows it. */
  | { readonly t: "begin"; readonly final: Lsn; readonly xid: number }
  | { readonly t: "commit"; readonly lsn: Lsn; readonly end: Lsn }
  | { readonly t: "relation"; readonly relation: Relation }
  | { readonly t: "insert"; readonly relation: number; readonly tuple: Tuple }
  | {
      readonly t: "update";
      readonly relation: number;
      readonly old: OldTuple | undefined;
      readonly tuple: Tuple;
    }
  | { readonly t: "delete"; readonly relation: number; readonly old: OldTuple }
  | { readonly t: "truncate"; readonly relations: readonly number[] }
  /** Origin, type and logical-message records: carried by the protocol, nothing to us. */
  | { readonly t: "ignored"; readonly tag: string };

/** One frame of the copy-both stream, from the server. */
export type ServerFrame =
  | { readonly t: "xlog"; readonly start: Lsn; readonly payload: Uint8Array }
  | { readonly t: "keepalive"; readonly end: Lsn; readonly reply: boolean };

const IDENTITY = new Map<string, ReplicaIdentity>([
  ["d", "default"],
  ["n", "nothing"],
  ["f", "full"],
  ["i", "index"],
]);

/** Origin, type and logical-message records. */
const IGNORED = new Set(["O", "Y", "M"]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A cursor over one message. Every read checks the length first and throws a `RangeError`
 * past the end; {@link decodePgOutput} and {@link parseServerFrame} are the one place that
 * becomes a value.
 */
class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  private take(length: number): number {
    const at = this.offset;
    if (at + length > this.bytes.length) {
      throw new RangeError(`read of ${length} at ${at} runs past ${this.bytes.length} bytes`);
    }
    this.offset += length;
    return at;
  }

  byte(): number {
    return this.view.getUint8(this.take(1));
  }

  char(): string {
    return String.fromCharCode(this.byte());
  }

  int16(): number {
    return this.view.getInt16(this.take(2));
  }

  int32(): number {
    return this.view.getInt32(this.take(4));
  }

  uint32(): number {
    return this.view.getUint32(this.take(4));
  }

  uint64(): bigint {
    return this.view.getBigUint64(this.take(8));
  }

  lsn(): Lsn {
    return lsnFrom(this.uint64()).unwrap();
  }

  /** A NUL-terminated string. */
  cstring(): string {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0) throw new RangeError(`unterminated string at ${this.offset}`);
    const text = utf8.decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return text;
  }

  slice(length: number): Uint8Array {
    const at = this.take(length);
    return this.bytes.subarray(at, at + length);
  }

  rest(): Uint8Array {
    return this.slice(this.bytes.length - this.offset);
  }
}

function tuple(reader: Reader): Tuple {
  const count = reader.int16();
  const cells: TupleCell[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = reader.char();
    if (kind === "n") cells.push({ kind: "null" });
    else if (kind === "u") cells.push({ kind: "unchanged" });
    else if (kind === "t")
      cells.push({ kind: "text", text: utf8.decode(reader.slice(reader.int32())) });
    else if (kind === "b") cells.push({ kind: "binary", bytes: reader.slice(reader.int32()) });
    else throw new RangeError(`unknown tuple cell kind "${kind}"`);
  }
  return cells;
}

function relation(reader: Reader): Relation {
  const oid = reader.uint32();
  const schema = reader.cstring();
  const table = reader.cstring();
  const flag = reader.char();
  const identity = IDENTITY.get(flag);
  if (identity === undefined) throw new RangeError(`unknown replica identity "${flag}"`);
  const count = reader.int16();
  const columns: RelationColumn[] = [];
  for (let i = 0; i < count; i += 1) {
    const flags = reader.byte();
    columns.push({
      key: (flags & 1) === 1,
      name: reader.cstring(),
      type: reader.uint32(),
      typmod: reader.int32(),
    });
  }
  return { oid, schema, table: table, identity, columns };
}

function oldTuple(reader: Reader, marker: string): OldTuple {
  if (marker === "K") return { kind: "key", tuple: tuple(reader) };
  if (marker === "O") return { kind: "full", tuple: tuple(reader) };
  throw new RangeError(`expected K or O, got "${marker}"`);
}

function message(reader: Reader, tag: string): PgOutputMessage {
  if (IGNORED.has(tag)) {
    reader.rest();
    return { t: "ignored", tag };
  }
  switch (tag) {
    case "B": {
      const final = reader.lsn();
      reader.uint64(); // commit timestamp
      return { t: "begin", final, xid: reader.uint32() };
    }
    case "C": {
      reader.byte(); // flags, unused
      const lsn = reader.lsn();
      const end = reader.lsn();
      reader.uint64(); // commit timestamp
      return { t: "commit", lsn, end };
    }
    case "R":
      return { t: "relation", relation: relation(reader) };
    case "I": {
      const oid = reader.uint32();
      const marker = reader.char();
      if (marker !== "N") throw new RangeError(`insert without a new tuple ("${marker}")`);
      return { t: "insert", relation: oid, tuple: tuple(reader) };
    }
    case "U": {
      const oid = reader.uint32();
      const marker = reader.char();
      const old = marker === "N" ? undefined : oldTuple(reader, marker);
      if (old !== undefined && reader.char() !== "N") {
        throw new RangeError("update without a new tuple");
      }
      return { t: "update", relation: oid, old, tuple: tuple(reader) };
    }
    case "D": {
      const oid = reader.uint32();
      return { t: "delete", relation: oid, old: oldTuple(reader, reader.char()) };
    }
    case "T": {
      const count = reader.int32();
      reader.byte(); // CASCADE / RESTART IDENTITY: nothing to us
      const relations: number[] = [];
      for (let i = 0; i < count; i += 1) relations.push(reader.uint32());
      return { t: "truncate", relations };
    }
    default:
      throw new RangeError(`unknown pgoutput message "${tag}"`);
  }
}

/** One `pgoutput` message: the payload of an `XLogData` frame. */
export function decodePgOutput(bytes: Uint8Array): Result<PgOutputMessage, MalformedMessage> {
  const tag = bytes.length === 0 ? "" : String.fromCharCode(bytes[0] ?? 0);
  return Result.try({
    try: () => {
      const reader = new Reader(bytes);
      reader.byte();
      const decoded = message(reader, tag);
      if (!reader.done) throw new RangeError(`${tag}: trailing bytes`);
      return decoded;
    },
    catch: (cause) =>
      new MalformedMessage({ tag, message: `pgoutput "${tag}": ${describe(cause)}`, cause }),
  });
}

/** One frame of the copy-both stream: `XLogData` (`w`) or a primary keepalive (`k`). */
export function parseServerFrame(bytes: Uint8Array): Result<ServerFrame, MalformedMessage> {
  const tag = bytes.length === 0 ? "" : String.fromCharCode(bytes[0] ?? 0);
  return Result.try({
    try: (): ServerFrame => {
      const reader = new Reader(bytes);
      reader.byte();
      if (tag === "w") {
        const start = reader.lsn();
        reader.uint64(); // the server's current WAL end
        reader.uint64(); // send time
        return { t: "xlog", start, payload: reader.rest() };
      }
      if (tag === "k") {
        const end = reader.lsn();
        reader.uint64(); // send time
        return { t: "keepalive", end, reply: reader.byte() === 1 };
      }
      throw new RangeError(`unknown frame "${tag}"`);
    },
    catch: (cause) =>
      new MalformedMessage({ tag, message: `frame "${tag}": ${describe(cause)}`, cause }),
  });
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : "unreadable");

/** Microseconds from the Unix epoch to Postgres's, 2000-01-01T00:00:00Z. */
const PG_EPOCH_MICROS = 946_684_800_000_000n;

/**
 * A standby status update (`r`): `lsn` as written, flushed and applied. A logical slot reads
 * the flushed position as its `confirmed_flush_lsn`, so this frame **is** the ack — nothing else
 * the client sends moves the slot.
 */
export function standbyStatus(lsn: Lsn, at: Temporal.Instant): Uint8Array {
  const bytes = new Uint8Array(34);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x72; // 'r'
  view.setBigUint64(1, lsn);
  view.setBigUint64(9, lsn);
  view.setBigUint64(17, lsn);
  view.setBigInt64(25, at.epochNanoseconds / 1000n - PG_EPOCH_MICROS);
  bytes[33] = 0; // no reply requested
  return bytes;
}
