import { rowIs } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import { decodeWindowFrame } from "../frames.js";
import { createClientView } from "../view.js";
import {
  AT,
  CALLS,
  FOLDER,
  MAIL,
  SUBJECT,
  after,
  ats,
  down,
  harness,
  mail,
  mailKey,
  newest,
} from "./fixtures.js";

const lastPatch = (frames: readonly Uint8Array[]) => {
  const frame = decodeWindowFrame(frames.at(-1) ?? new Uint8Array()).unwrap();
  if (frame?.kind !== "rows") throw new Error("expected a rows frame");
  return frame;
};

describe("a window over a row source (E27)", () => {
  test("opening a window sends its rows once, as a reset, in the window's order", () => {
    const { client, view, frames } = harness(100);
    client.desire("inbox", newest(5));
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    expect(lastPatch(frames)).toMatchObject({ reset: true, version: 1 });
    expect(view.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("a scroll moves the window: new rows are put, rows off-screen are evicted", () => {
    const { client, view, frames } = harness(100);
    client.desire("inbox", newest(5));
    client.desire("inbox", newest(5, { after: after(96) }));
    expect(ats(client.rows("inbox"))).toEqual(down(95, 5));
    const scrolled = lastPatch(frames);
    expect(scrolled.puts.map((p) => p.row.get(AT))).toEqual(down(95, 5));
    expect(scrolled.dels.map((d) => d.key)).toEqual(down(100, 5).map(mailKey));
    expect(view.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("a half scroll sends only the rows that are new to the socket", () => {
    const { client, frames } = harness(100);
    client.desire("inbox", newest(6));
    client.desire("inbox", newest(6, { after: after(97) }));
    const patch = lastPatch(frames);
    expect(patch.puts.map((p) => p.row.get(AT))).toEqual([94, 93, 92, 91]);
    expect(patch.dels.map((d) => d.key)).toEqual([100, 99, 98, 97].map(mailKey));
    expect(ats(client.rows("inbox"))).toEqual(down(96, 6));
  });

  test("rows are refcounted across windows: evicted only when no window holds them", () => {
    const { client, view, frames } = harness(100);
    client.desire("wide", newest(10));
    client.desire("narrow", newest(4));
    // the narrow window's rows were already on the socket: nothing travels but its key list
    expect(lastPatch(frames).puts).toEqual([]);
    client.undesire("wide");
    expect(lastPatch(frames).dels.map((d) => d.key)).toEqual(down(96, 6).map(mailKey));
    expect(view.held()).toBe(4);
    client.undesire("narrow");
    expect(view.held()).toBe(0);
    expect(client.held()).toBe(0);
  });

  test("an insert inside the window enters it and pushes the last row out", () => {
    const { client, source, view } = harness(100);
    client.desire("inbox", newest(5));
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
    expect(view.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("an insert outside a full window sends nothing at all", () => {
    const { client, source, frames } = harness(100);
    client.desire("inbox", newest(5));
    const before = frames.length;
    source.write([{ table: MAIL, key: mailKey(1000), row: mail(50) }]);
    source.write([{ table: CALLS, key: mailKey(1), row: mail(500) }]);
    expect(frames.length).toBe(before);
  });

  test("a delete inside the window pulls the next row up; one outside sends nothing", () => {
    const { client, source, frames } = harness(100);
    client.desire("inbox", newest(5));
    source.write([{ table: MAIL, key: mailKey(98) }]);
    expect(ats(client.rows("inbox"))).toEqual([100, 99, 97, 96, 95]);
    expect(lastPatch(frames).dels.map((d) => d.key)).toEqual([mailKey(98)]);
    const before = frames.length;
    source.write([{ table: MAIL, key: mailKey(10) }]);
    expect(frames.length).toBe(before);
  });

  test("a changed row in the window is put again; a row moving out of `where` leaves", () => {
    const { client, source, frames } = harness(100);
    client.desire("inbox", newest(3, { where: rowIs({ folder: "inbox" }) }));
    source.write([{ table: MAIL, key: mailKey(99), row: mail(99, "archive") }]);
    expect(ats(client.rows("inbox"))).toEqual([100, 98, 97]);
    source.write([{ table: MAIL, key: mailKey(99), row: mail(99, "inbox") }]);
    expect(ats(client.rows("inbox"))).toEqual([100, 99, 98]);
    const renamed = new Map(mail(100));
    renamed.set(FOLDER, "inbox");
    renamed.set(SUBJECT, "renamed");
    source.write([{ table: MAIL, key: mailKey(100), row: renamed }]);
    // the key list did not move, so only the changed row travels
    expect(lastPatch(frames).windows).toEqual([]);
    expect(client.rows("inbox")[0]?.row.get(SUBJECT)).toBe("renamed");
  });

  test("a lost patch is a gap: the client asks again and the view answers with a reset", () => {
    const { client, source, loseNext, frames } = harness(100);
    client.desire("inbox", newest(5));
    loseNext();
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    // the client never saw the insert, so it still shows the old window and does not know it
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    const reset = lastPatch(frames);
    expect(reset).toMatchObject({ reset: true, version: 1 });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
  });

  test("a client on a new socket re-desires and the new view resnapshots it", () => {
    const { client, source, view } = harness(100);
    client.desire("inbox", newest(5));
    // the socket drops: its view closes with it
    view.close();
    client.detach();
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    expect(client.status()).toBe("detached");
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    const next = createClientView({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
    expect(client.status()).toBe("live");
  });

  test("a window the source cannot serve, or a query that does not parse, is refused", () => {
    const { client, view } = harness(10);
    client.desire("calls", newest(5, { table: CALLS }));
    expect(client.refusal("calls")).toBe("no table calls");
    expect(view.receive(Uint8Array.from([0x83, 0x18, 0x20, 0x61, 0x78, 0x61, 0x7b]))).toBe(true);
    client.desire("huge", newest(5000));
    expect(client.refusal("huge")).toContain("limit");
    expect(client.rows("huge")).toEqual([]);
  });

  test("the read policy decides before `where` narrows", () => {
    const { client } = harness(20, { admits: (_, row) => Number(row.get(AT)) % 2 === 0 });
    client.desire("inbox", newest(3));
    expect(ats(client.rows("inbox"))).toEqual([20, 18, 16]);
  });
});
