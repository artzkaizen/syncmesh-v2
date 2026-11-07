import type { ColumnName } from "@syncmesh/kernel";

import { rowIs } from "@syncmesh/policy";
import { describe, expect, test } from "bun:test";

import { createWindowClient } from "../client.js";
import { decodeWindowFrame } from "../frames.js";
import { MAX_ORDER, queryText } from "../query.js";
import { createMemoryRowSource } from "../source.js";
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

  test("a gap before the first reset still asks for one, though the client has no position", () => {
    const { client, source, loseNext, frames } = harness(100);
    // the opening reset never arrives, so the next patch is a gap with nothing to resume from
    loseNext();
    client.desire("inbox", newest(5));
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    expect(lastPatch(frames)).toMatchObject({ reset: true });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
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

  test("a reconnect keeps every window on screen until the new view has named them all", () => {
    const { client, source, view } = harness(100);
    client.desire("a", newest(3));
    client.desire("b", newest(3, { where: rowIs({ folder: "inbox" }), after: after(50) }));
    view.close();
    client.detach();
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    const seen: { a: unknown[]; b: unknown[] }[] = [];
    client.subscribe(() => seen.push({ a: ats(client.rows("a")), b: ats(client.rows("b")) }));
    const next = createClientView({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    // one swap, after both windows arrived: never a screen with `b` blank
    expect(seen).toEqual([{ a: [101, 100, 99], b: [49, 48, 47] }]);
    expect(client.status()).toBe("live");
    expect(client.held()).toBe(6);
  });

  test("a window refused before a gap does not hold the resnapshot back", () => {
    const { client, source, loseNext } = harness(100);
    client.desire("calls", newest(5, { table: CALLS }));
    client.desire("inbox", newest(5));
    loseNext();
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.refusal("calls")).toBe("no table calls");
  });

  test("a lost refusal does not hold the resnapshot back either", () => {
    const { client, source, loseNext } = harness(100);
    client.desire("inbox", newest(5));
    loseNext();
    client.desire("calls", newest(5, { table: CALLS }));
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    expect(client.status()).toBe("live");
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.rows("calls")).toEqual([]);
  });

  test("a lost `maxWindows` refusal does not hold the resnapshot back", () => {
    const { client, source, loseNext } = harness(100, { maxWindows: 1 });
    client.desire("inbox", newest(5));
    loseNext();
    client.desire("extra", newest(5, { after: after(50) }));
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.rows("extra")).toEqual([]);
  });

  test("a patch lost after the last undesire is caught by the next desire", () => {
    const { client, loseNext } = harness(100);
    client.desire("a", newest(3));
    client.desire("b", newest(3));
    client.undesire("a");
    loseNext();
    client.undesire("b");
    // the `del`s for b were lost, and with no window open nothing else arrives to show the gap
    client.desire("c", newest(2, { after: after(10) }));
    expect(client.status()).toBe("live");
    expect(ats(client.rows("c"))).toEqual([9, 8]);
    expect(client.held()).toBe(2);
  });

  test("a lost reset that answered a gap is caught by the next patch, which asks again", () => {
    const { client, source, spoil, frames } = harness(100);
    client.desire("inbox", newest(5));
    // v2 is lost, v3 shows the gap, and the reset that answers it is lost too
    spoil("lose", 0, 2);
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    expect(client.status()).toBe("resyncing");
    // the view's next patch is in the epoch whose reset never arrived
    source.write([{ table: MAIL, key: mailKey(103), row: mail(103) }]);
    expect(lastPatch(frames)).toMatchObject({ reset: true, version: 1 });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(103, 5));
  });

  test("a desire after a lost answer asks again, and its window shows", () => {
    const { client, source, spoil } = harness(100);
    client.desire("inbox", newest(5));
    spoil("lose", 0, 2);
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    client.desire("other", newest(2, { after: after(50) }));
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(ats(client.rows("other"))).toEqual([49, 48]);
  });

  test("a garbled answer to a gap asks again at once", () => {
    const { client, source, spoil, frames } = harness(100);
    client.desire("inbox", newest(5));
    spoil("lose", 0);
    spoil("garble", 2);
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    expect(lastPatch(frames)).toMatchObject({ reset: true });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
  });

  test("patches already on the socket when the client asks do not ask again", () => {
    const source = createMemoryRowSource();
    source.load(
      MAIL,
      Array.from({ length: 100 }, (_, i) => ({ key: mailKey(i + 1), row: mail(i + 1) })),
    );
    const client = createWindowClient();
    const queue: Uint8Array[] = [];
    let resets = 0;
    const view = createClientView({
      source,
      send: (frame) => {
        if (lastPatch([frame]).reset) resets++;
        queue.push(frame);
      },
    });
    const deliver = () => {
      const frame = queue.shift();
      if (frame !== undefined) client.receive(frame);
    };
    client.attach((frame) => view.receive(frame));
    client.desire("inbox", newest(5));
    deliver();
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    queue.shift();
    source.write([{ table: MAIL, key: mailKey(102), row: mail(102) }]);
    source.write([{ table: MAIL, key: mailKey(103), row: mail(103) }]);
    // v3 shows the gap and the client asks; v4 was sent before the view read the ask
    deliver();
    deliver();
    expect(client.status()).toBe("resyncing");
    deliver();
    expect(resets).toBe(2);
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(103, 5));
  });

  test("a socket with no window open is sent nothing when the source changes", () => {
    const { source, frames } = harness(100);
    source.write([{ table: MAIL, key: mailKey(101), row: mail(101) }]);
    expect(frames).toEqual([]);
  });

  test("an undesire while detached lets go of the window's rows at once", () => {
    const { client, view } = harness(100);
    client.desire("a", newest(3));
    client.desire("b", newest(3, { after: after(50) }));
    view.close();
    client.detach();
    client.undesire("b");
    expect(client.held()).toBe(3);
    expect(ats(client.rows("a"))).toEqual(down(100, 3));
  });

  test("NaN orders after every number, so the order stays total", () => {
    const source = createMemoryRowSource();
    source.load(MAIL, [
      { key: mailKey(1), row: new Map([[AT, Number.NaN]]) },
      { key: mailKey(2), row: new Map([[AT, 5]]) },
      { key: mailKey(3), row: new Map([[AT, Number.NaN]]) },
      { key: mailKey(4), row: new Map([[AT, 7]]) },
    ]);
    const read = source.window({ table: MAIL, order: [[AT, "asc"]], limit: 10 }, () => true);
    expect(read.unwrap().map((r) => r.key)).toEqual([
      mailKey(2),
      mailKey(4),
      mailKey(1),
      mailKey(3),
    ]);
    const tail = source.window(
      {
        table: MAIL,
        order: [[AT, "asc"]],
        limit: 10,
        after: { cells: [Number.NaN], key: mailKey(1) },
      },
      () => true,
    );
    expect(tail.unwrap().map((r) => r.key)).toEqual([mailKey(3)]);
  });

  test("a socket holds at most `maxWindows`; a desire past it is refused, a move is not", () => {
    const { client, view } = harness(100, { maxWindows: 2 });
    client.desire("a", newest(3));
    client.desire("b", newest(3, { after: after(50) }));
    client.desire("c", newest(3, { after: after(20) }));
    expect(client.refusal("c")).toBe("a socket holds at most 2 windows");
    expect(client.rows("c")).toEqual([]);
    expect(view.held()).toBe(6);
    client.desire("a", newest(3, { after: after(80) }));
    expect(ats(client.rows("a"))).toEqual(down(79, 3));
    client.undesire("b");
    client.desire("c", newest(3, { after: after(20) }));
    expect(client.refusal("c")).toBeUndefined();
    expect(ats(client.rows("c"))).toEqual(down(19, 3));
  });

  test("a window refused on one socket and served on the next is no longer reported refused", () => {
    const { client, source, view } = harness(100, { maxWindows: 1 });
    client.desire("a", newest(2));
    client.desire("b", newest(2, { after: after(50) }));
    expect(client.refusal("b")).toBe("a socket holds at most 1 windows");
    view.close();
    client.detach();
    const seen: unknown[] = [];
    client.subscribe(() => seen.push(ats(client.rows("b"))));
    const next = createClientView({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    // the swap waited for the new view's answer on `b` rather than trusting the old refusal
    expect(seen).toEqual([[49, 48]]);
    expect(client.refusal("b")).toBeUndefined();
    expect(client.status()).toBe("live");
  });

  test("a closed view reads no more desires and sends nothing", () => {
    const { client, view, frames } = harness(100);
    client.desire("a", newest(2));
    view.close();
    const sent = frames.length;
    client.desire("b", newest(2, { after: after(50) }));
    expect(view.held()).toBe(2);
    client.undesire("a");
    expect(view.held()).toBe(2);
    expect(frames.length).toBe(sent);
  });

  test("however many orders clients name, a table keeps at most `maxIndexes` sorted indexes", () => {
    const source = createMemoryRowSource({ maxIndexes: 2 });
    source.load(
      MAIL,
      Array.from({ length: 50 }, (_, i) => ({ key: mailKey(i + 1), row: mail(i + 1) })),
    );
    const view = createClientView({ source, send: () => {} });
    for (let i = 0; i < 20; i++)
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- a column no row holds
      view.desire("w", queryText(newest(1, { order: [[`x${i}` as ColumnName, "asc"]] })));
    expect(source.indexed()).toBe(2);
    // an order whose index was dropped is rebuilt, current with every write since
    source.write([{ table: MAIL, key: mailKey(51), row: mail(51) }]);
    const read = source.window(newest(3), () => true).unwrap();
    expect(read.map((r) => r.row.get(AT))).toEqual(down(51, 3));
    expect(source.indexed()).toBe(2);
  });

  test("an order of more than `MAX_ORDER` terms is refused", () => {
    const { client } = harness(10);
    const order = Array.from({ length: MAX_ORDER + 1 }, () => [AT, "asc"] as const);
    client.desire("wide", newest(5, { order }));
    expect(client.refusal("wide")).toBe(`order names at most ${MAX_ORDER} columns`);
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
