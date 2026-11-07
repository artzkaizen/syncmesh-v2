import { describe, expect, test } from "bun:test";

import { decodeWindowFrame } from "../frames.js";
import { createServerWindows } from "../server.js";
import {
  AT,
  CALLS,
  FOLDER,
  MAIL,
  SUBJECT,
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

describe("a socket's windows over a page source (E27)", () => {
  test("opening a window sends its rows once, as a reset, in the read's order", async () => {
    const { client, server, frames } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    expect(lastPatch(frames)).toMatchObject({ reset: true, version: 1 });
    expect(server.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("the next page moves the window: new rows are put, rows off-screen are evicted", async () => {
    const { client, server, frames } = harness(100);
    client.open("inbox", newest(5));
    client.open("inbox", newest(5, { after: 96 }));
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(95, 5));
    const scrolled = lastPatch(frames);
    expect(scrolled.puts.map((p) => p.row.get(AT))).toEqual(down(95, 5));
    expect(scrolled.dels.map((d) => d.key)).toEqual(down(100, 5).map(mailKey));
    expect(server.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("a half scroll sends only the rows that are new to the socket", async () => {
    const { client, server, frames } = harness(100);
    client.open("inbox", newest(6));
    client.open("inbox", newest(6, { after: 97 }));
    await server.idle();
    const patch = lastPatch(frames);
    expect(patch.puts.map((p) => p.row.get(AT))).toEqual([94, 93, 92, 91]);
    expect(patch.dels.map((d) => d.key)).toEqual([100, 99, 98, 97].map(mailKey));
    expect(ats(client.rows("inbox"))).toEqual(down(96, 6));
  });

  test("rows are refcounted across windows: evicted only when no window holds them", async () => {
    const { client, server, frames } = harness(100);
    client.open("wide", newest(10));
    client.open("narrow", newest(4));
    await server.idle();
    // the narrow window's rows were already on the socket: nothing travels but its key list
    expect(lastPatch(frames).puts).toEqual([]);
    client.close("wide");
    await server.idle();
    expect(lastPatch(frames).dels.map((d) => d.key)).toEqual(down(96, 6).map(mailKey));
    expect(server.held()).toBe(4);
    client.close("narrow");
    await server.idle();
    expect(server.held()).toBe(0);
    expect(client.held()).toBe(0);
  });

  test("an insert inside the window enters it and pushes the last row out", async () => {
    const { client, source, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
    expect(server.held()).toBe(5);
    expect(client.held()).toBe(5);
  });

  test("an insert outside a full window sends nothing; another table's is not even read", async () => {
    const { client, source, server, frames } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    const before = frames.length;
    const reads = source.pagesRead();
    source.write(MAIL, [{ key: mailKey(1000), row: mail(50) }]);
    await server.idle();
    expect(frames.length).toBe(before);
    expect(source.pagesRead()).toBe(reads + 1);
    source.write(CALLS, [{ key: mailKey(1), row: mail(500) }]);
    await server.idle();
    expect(source.pagesRead()).toBe(reads + 1);
    expect(frames.length).toBe(before);
  });

  test("a delete inside the window pulls the next row up; one outside sends nothing", async () => {
    const { client, source, server, frames } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    source.write(MAIL, [{ key: mailKey(98) }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual([100, 99, 97, 96, 95]);
    expect(lastPatch(frames).dels.map((d) => d.key)).toEqual([mailKey(98)]);
    const before = frames.length;
    source.write(MAIL, [{ key: mailKey(10) }]);
    await server.idle();
    expect(frames.length).toBe(before);
  });

  test("a changed row in the window is put again; a row moving out of `where` leaves", async () => {
    const { client, source, server, frames } = harness(100);
    client.open("inbox", newest(3, { folder: "inbox" }));
    await server.idle();
    source.write(MAIL, [{ key: mailKey(99), row: mail(99, "archive") }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual([100, 98, 97]);
    source.write(MAIL, [{ key: mailKey(99), row: mail(99, "inbox") }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual([100, 99, 98]);
    const renamed = new Map(mail(100));
    renamed.set(FOLDER, "inbox");
    renamed.set(SUBJECT, "renamed");
    source.write(MAIL, [{ key: mailKey(100), row: renamed }]);
    await server.idle();
    // the key list did not move, so only the changed row travels
    expect(lastPatch(frames).windows).toEqual([]);
    expect(lastPatch(frames).puts.map((p) => p.key)).toEqual([mailKey(100)]);
    expect(client.rows("inbox")[0]?.row.get(SUBJECT)).toBe("renamed");
  });

  test("a lost patch is a gap: the client asks again and the server answers with a reset", async () => {
    const { client, source, loseNext, frames, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    loseNext();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    // the client never saw the insert, so it still shows the old window and does not know it
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(lastPatch(frames)).toMatchObject({ reset: true, version: 1 });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
  });

  test("a gap before the first reset still asks for one, though the client has no position", async () => {
    const { client, source, loseNext, frames, server } = harness(100);
    // the opening reset never arrives, so the next patch is a gap with nothing to resume from
    loseNext();
    client.open("inbox", newest(5));
    await server.idle();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    expect(lastPatch(frames)).toMatchObject({ reset: true });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
  });

  test("a client on a new socket opens its windows again and is resnapshotted", async () => {
    const { client, source, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    // the socket drops: its server windows stop with it
    server.stop();
    client.detach();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    expect(client.status()).toBe("detached");
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    const next = createServerWindows({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    await next.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(101, 5));
    expect(client.status()).toBe("live");
  });

  test("a reconnect keeps every window on screen until the new socket has named them all", async () => {
    const { client, source, server } = harness(100);
    client.open("a", newest(3));
    client.open("b", newest(3, { folder: "inbox", after: 50 }));
    await server.idle();
    server.stop();
    client.detach();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    const seen: { a: unknown[]; b: unknown[] }[] = [];
    client.subscribe(() => seen.push({ a: ats(client.rows("a")), b: ats(client.rows("b")) }));
    const next = createServerWindows({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    await next.idle();
    // one swap, after both windows arrived: never a screen with `b` blank
    expect(seen).toEqual([{ a: [101, 100, 99], b: [49, 48, 47] }]);
    expect(client.status()).toBe("live");
    expect(client.held()).toBe(6);
  });

  test("a window refused before a gap does not hold the resnapshot back", async () => {
    const { client, source, loseNext, server } = harness(100);
    client.open("calls", { path: "calls.recent", input: { limit: 5 } });
    client.open("inbox", newest(5));
    await server.idle();
    loseNext();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.refusal("calls")).toBe("no read calls.recent");
  });

  test("a patch lost after the last close is caught by the next open", async () => {
    const { client, loseNext, server } = harness(100);
    client.open("a", newest(3));
    client.open("b", newest(3));
    client.close("a");
    await server.idle();
    loseNext();
    client.close("b");
    await server.idle();
    // the `del`s for b were lost, and with no window open nothing else arrives to show the gap
    client.open("c", newest(2, { after: 10 }));
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("c"))).toEqual([9, 8]);
    expect(client.held()).toBe(2);
  });

  test("a socket holds at most `maxWindows`; an open past it is refused, a move is not", async () => {
    const { client, server } = harness(100, { maxWindows: 2 });
    client.open("a", newest(3));
    client.open("b", newest(3, { after: 51 }));
    client.open("c", newest(3, { after: 21 }));
    await server.idle();
    expect(client.refusal("c")).toBe("a socket holds at most 2 windows");
    expect(client.rows("c")).toEqual([]);
    expect(server.held()).toBe(6);
    client.open("a", newest(3, { after: 80 }));
    await server.idle();
    expect(ats(client.rows("a"))).toEqual(down(79, 3));
    client.close("b");
    client.open("c", newest(3, { after: 20 }));
    await server.idle();
    expect(client.refusal("c")).toBeUndefined();
    expect(ats(client.rows("c"))).toEqual(down(19, 3));
  });

  test("a read the source does not serve, or a request that does not parse, is refused", async () => {
    const { client, server } = harness(10);
    client.open("calls", { path: "calls.recent", input: null });
    await server.idle();
    expect(client.refusal("calls")).toBe("no read calls.recent");
    // [32, "x", "{"]: a desire whose request is not JSON
    expect(server.receive(Uint8Array.from([0x83, 0x18, 0x20, 0x61, 0x78, 0x61, 0x7b]))).toBe(true);
    await server.idle();
    expect(client.rows("calls")).toEqual([]);
  });

  test("the read permission decides before the read's own filter narrows", async () => {
    const { client, server } = harness(20, {
      canRead: (_, row) => Number(row.get(AT)) % 2 === 0,
    });
    client.open("inbox", newest(3));
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual([20, 18, 16]);
  });
});
