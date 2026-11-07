import { parseWatermark } from "@syncmesh/cdc";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import {
  cellValue,
  decodePgOutput,
  lsnText,
  lsnWatermark,
  parseLsn,
  parseLsnWatermark,
  parseServerFrame,
  standbyStatus,
} from "../index.js";

/** A tiny big-endian writer: the frames below are built the way a walsender builds them. */
class Bytes {
  private readonly parts: number[] = [];
  char(c: string) {
    this.parts.push(c.charCodeAt(0));
    return this;
  }
  byte(n: number) {
    this.parts.push(n & 0xff);
    return this;
  }
  int16(n: number) {
    this.parts.push((n >> 8) & 0xff, n & 0xff);
    return this;
  }
  int32(n: number) {
    this.parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    return this;
  }
  int64(n: bigint) {
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.parts.push(Number((n >> shift) & 0xffn));
    return this;
  }
  cstring(s: string) {
    for (const b of new TextEncoder().encode(s)) this.parts.push(b);
    this.parts.push(0);
    return this;
  }
  text(s: string) {
    const encoded = new TextEncoder().encode(s);
    this.char("t").int32(encoded.length);
    for (const b of encoded) this.parts.push(b);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

const decoded = (bytes: Uint8Array) => decodePgOutput(bytes).unwrap();
const lsn = (text: string) => parseLsn(text).unwrap();

describe("pgoutput, message by message", () => {
  test("begin and commit carry the positions the acks are made of", () => {
    const begin = new Bytes().char("B").int64(0x1_0000_00a0n).int64(0n).int32(731).done();
    expect(decoded(begin)).toEqual({ t: "begin", final: lsn("1/A0"), xid: 731 });

    const commit = new Bytes()
      .char("C")
      .byte(0)
      .int64(0x1_0000_00a0n)
      .int64(0x1_0000_00d8n)
      .int64(0n);
    expect(decoded(commit.done())).toEqual({ t: "commit", lsn: lsn("1/A0"), end: lsn("1/D8") });
  });

  test("a relation names its columns, their types and which of them are the identity", () => {
    const bytes = new Bytes()
      .char("R")
      .int32(16_384)
      .cstring("crm")
      .cstring("tasks")
      .char("f")
      .int16(2)
      .byte(1)
      .cstring("id")
      .int32(25)
      .int32(-1)
      .byte(0)
      .cstring("rank")
      .int32(23)
      .int32(-1)
      .done();
    expect(decoded(bytes)).toEqual({
      t: "relation",
      relation: {
        oid: 16_384,
        schema: "crm",
        table: "tasks",
        identity: "full",
        columns: [
          { key: true, name: "id", type: 25, typmod: -1 },
          { key: false, name: "rank", type: 23, typmod: -1 },
        ],
      },
    });
  });

  test("tuples: text, null and an unchanged TOAST value, which is absent rather than null", () => {
    const bytes = new Bytes().char("I").int32(7).char("N").int16(3).text("a").char("n").char("u");
    expect(decoded(bytes.done())).toEqual({
      t: "insert",
      relation: 7,
      tuple: [{ kind: "text", text: "a" }, { kind: "null" }, { kind: "unchanged" }],
    });
  });

  test("an update may carry the old key (K) or the whole old row (O) before the new one", () => {
    const keyed = new Bytes()
      .char("U")
      .int32(7)
      .char("K")
      .int16(1)
      .text("old")
      .char("N")
      .int16(1)
      .text("new");
    expect(decoded(keyed.done())).toEqual({
      t: "update",
      relation: 7,
      old: { kind: "key", tuple: [{ kind: "text", text: "old" }] },
      tuple: [{ kind: "text", text: "new" }],
    });
    const full = new Bytes()
      .char("U")
      .int32(7)
      .char("O")
      .int16(1)
      .text("x")
      .char("N")
      .int16(1)
      .text("y");
    expect(decoded(full.done())).toMatchObject({ old: { kind: "full" } });
    const plain = new Bytes().char("U").int32(7).char("N").int16(1).text("y");
    expect(decoded(plain.done())).toMatchObject({ old: undefined });
  });

  test("a delete carries only what identifies the row", () => {
    const bytes = new Bytes().char("D").int32(7).char("K").int16(1).text("t1").done();
    expect(decoded(bytes)).toEqual({
      t: "delete",
      relation: 7,
      old: { kind: "key", tuple: [{ kind: "text", text: "t1" }] },
    });
  });

  test("one truncate can name several relations", () => {
    const bytes = new Bytes().char("T").int32(2).byte(0).int32(7).int32(9).done();
    expect(decoded(bytes)).toEqual({ t: "truncate", relations: [7, 9] });
  });

  test("origin and type records are read past, not refused", () => {
    expect(
      decoded(new Bytes().char("Y").int32(1).cstring("public").cstring("mood").done()),
    ).toEqual({
      t: "ignored",
      tag: "Y",
    });
  });

  test("a short message, a stray byte or an unknown tag is a value, never a throw", () => {
    const short = new Bytes().char("B").int64(1n).done();
    expect(decodePgOutput(short).isErr()).toBe(true);
    const trailing = new Bytes().char("T").int32(0).byte(0).byte(9).done();
    expect(decodePgOutput(trailing).isErr()).toBe(true);
    expect(decodePgOutput(new Bytes().char("Z").done()).isErr()).toBe(true);
    expect(decodePgOutput(new Uint8Array()).isErr()).toBe(true);
  });
});

describe("the copy-both frames around it", () => {
  test("XLogData and keepalives", () => {
    const xlog = new Bytes().char("w").int64(0x10n).int64(0x20n).int64(0n).char("B").done();
    const frame = parseServerFrame(xlog).unwrap();
    expect(frame).toMatchObject({ t: "xlog", start: lsn("0/10") });
    expect(frame.t === "xlog" && [...frame.payload]).toEqual([0x42]);

    const keepalive = new Bytes().char("k").int64(0x30n).int64(0n).byte(1).done();
    expect(parseServerFrame(keepalive).unwrap()).toEqual({
      t: "keepalive",
      end: lsn("0/30"),
      reply: true,
    });
  });

  test("a standby status update reports one position as written, flushed and applied", () => {
    const at = Temporal.Instant.from("2000-01-01T00:00:01Z");
    const bytes = standbyStatus(lsn("2/10"), at);
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(34);
    expect(String.fromCharCode(bytes[0] ?? 0)).toBe("r");
    for (const offset of [1, 9, 17]) expect(view.getBigUint64(offset)).toBe(0x2_0000_0010n);
    expect(view.getBigInt64(25)).toBe(1_000_000n); // microseconds since Postgres's epoch
    expect(bytes[33]).toBe(0);
  });
});

describe("LSNs and the watermarks they become", () => {
  test("X/Y text round-trips, and is refused when it is not one", () => {
    expect(lsnText(lsn("16/B374D848"))).toBe("16/B374D848");
    expect(parseLsn("16-B374").isErr()).toBe(true);
  });

  test("watermark order is LSN order, which X/Y text order is not", () => {
    // the reason the text is never the watermark
    expect(["10/0", "9/0"].sort()).toEqual(["10/0", "9/0"]);
    const values = Array.from({ length: 500 }, () =>
      lsn(
        `${Math.floor(Math.random() * 2 ** 32).toString(16)}/${Math.floor(Math.random() * 2 ** 32).toString(16)}`,
      ),
    );
    values.push(lsn("0/0"), lsn("FFFFFFFF/FFFFFFFF"), lsn("9/0"), lsn("10/0"));
    const byLsn = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(lsnWatermark);
    const byText = values.map(lsnWatermark).sort();
    expect(byText).toEqual(byLsn);
    for (const value of values) expect(parseLsnWatermark(lsnWatermark(value)).unwrap()).toBe(value);
  });

  test("a watermark from some other source is refused, not read as a position", () => {
    // a manual source's counter: lexicographic too, but twenty digits and not an LSN
    expect(parseLsnWatermark(parseWatermark("00000000000000000001").unwrap()).isErr()).toBe(true);
    expect(parseLsnWatermark(parseWatermark("00000000000000ab").unwrap()).isErr()).toBe(true);
  });
});

describe("values, from their text form", () => {
  test("each type the mesh has a cell for", () => {
    expect(cellValue(16, "t")).toBe(true);
    expect(cellValue(23, "-42")).toBe(-42);
    expect(cellValue(20, "9007199254740991")).toBe(9_007_199_254_740_991);
    expect(cellValue(701, "1.5")).toBe(1.5);
    expect(cellValue(17, "\\x00ff")).toEqual(Uint8Array.from([0, 255]));
    expect(cellValue(3802, '{"a":[1,null]}')).toEqual({ a: [1, null] });
    expect(cellValue(1184, "2026-11-07 12:00:00.123+01")).toBe(
      Temporal.Instant.from("2026-11-07T11:00:00.123Z").epochMilliseconds,
    );
    expect(cellValue(1114, "2026-11-07 12:00:00")).toBe(
      Temporal.Instant.from("2026-11-07T12:00:00Z").epochMilliseconds,
    );
    expect(cellValue(1700, "1.10")).toBe("1.10"); // numeric keeps its digits
    expect(cellValue(2950, "6f1c1d4e-0000-4000-8000-000000000001")).toBe(
      "6f1c1d4e-0000-4000-8000-000000000001",
    );
  });

  test("a value that would lose something stays text, for the column check to refuse", () => {
    expect(cellValue(20, "9007199254740993")).toBe("9007199254740993");
    expect(cellValue(701, "NaN")).toBe("NaN");
    expect(cellValue(1184, "infinity")).toBe("infinity");
  });
});
