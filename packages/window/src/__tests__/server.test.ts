import type { RetryPolicy } from "@syncmesh/temporal";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { WindowClient } from "../client.js";
import type { ServerWindowsOptions } from "../server.js";
import type { FeedState, PageSource } from "../source.js";

import { createWindowClient } from "../client.js";
import { decodeWindowFrame, desireFrame, undesireFrame } from "../frames.js";
import { readKey, requestText } from "../request.js";
import { createServerWindows } from "../server.js";
import { ReadFailed, ReadRefused } from "../source.js";
import {
  AT,
  CALLS,
  FOLDER,
  MAIL,
  SUBJECT,
  ats,
  down,
  eventually,
  harness,
  mail,
  mailKey,
  newest,
} from "./fixtures.js";

const CALLS_READ = { path: "calls.recent", input: { limit: 5 } };

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

  test("a scroll is another read: its rows travel under it, and the old page's leave", async () => {
    const { client, server, frames } = harness(100);
    client.open("inbox", newest(6));
    await server.idle();
    client.open("inbox", newest(6, { after: 97 }));
    await server.idle();
    const patch = lastPatch(frames);
    // a row is one read's row, so 96 and 95 are sent again under the page that now shows them
    expect(patch.puts.map((p) => p.row.get(AT))).toEqual(down(96, 6));
    expect(patch.dels.map((d) => d.key)).toEqual(down(100, 6).map(mailKey));
    expect(ats(client.rows("inbox"))).toEqual(down(96, 6));
    expect(server.held()).toBe(6);
  });

  test("rows are refcounted across windows of one read: evicted only when no window holds them", async () => {
    const { client, server, frames } = harness(100);
    client.open("first", newest(4, { folder: "inbox" }));
    await server.idle();
    // the same read spelled with its keys the other way round is still the same read
    client.open("second", { path: "mail.inbox", input: { folder: "inbox", limit: 4 } });
    await server.idle();
    // the second window's rows were already on the socket: nothing travels but its key list
    expect(lastPatch(frames).puts).toEqual([]);
    expect(ats(client.rows("second"))).toEqual(down(100, 4));
    client.close("first");
    await server.idle();
    expect(server.held()).toBe(4);
    client.close("second");
    await server.idle();
    expect(lastPatch(frames).dels.map((d) => d.key)).toEqual(down(100, 4).map(mailKey));
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
  test("a lost refusal does not hold the resnapshot back either", async () => {
    const { client, source, loseNext, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    loseNext();
    client.open("calls", CALLS_READ);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    expect(client.status()).toBe("live");
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.rows("calls")).toEqual([]);
  });

  test("a lost `maxWindows` refusal does not hold the resnapshot back", async () => {
    const { client, source, loseNext, server } = harness(100, { maxWindows: 1 });
    client.open("inbox", newest(5));
    await server.idle();
    loseNext();
    client.open("extra", newest(5, { after: 51 }));
    await server.idle();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(client.rows("extra")).toEqual([]);
  });

  test("a lost reset that answered a gap is caught by the next patch, which asks again", async () => {
    const { client, source, spoil, frames, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    // v2 is lost, v3 shows the gap, and the reset that answers it is lost too
    spoil("lose", 0, 2);
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(client.status()).toBe("resyncing");
    // the server's next patch is in the epoch whose reset never arrived
    source.write(MAIL, [{ key: mailKey(103), row: mail(103) }]);
    await server.idle();
    expect(lastPatch(frames)).toMatchObject({ reset: true, version: 1 });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(103, 5));
  });

  test("an open after a lost answer asks again, and its window shows", async () => {
    const { client, source, spoil, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    spoil("lose", 0, 2);
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    client.open("other", newest(2, { after: 50 }));
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
    expect(ats(client.rows("other"))).toEqual([49, 48]);
  });

  test("a garbled answer to a gap asks again at once", async () => {
    const { client, source, spoil, frames, server } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    spoil("lose", 0);
    spoil("garble", 2);
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    expect(lastPatch(frames)).toMatchObject({ reset: true });
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 5));
  });

  test("patches already on the socket when the client asks do not ask again", async () => {
    const { source } = harness(100);
    const client = createWindowClient();
    const queue: Uint8Array[] = [];
    let resets = 0;
    const server = createServerWindows({
      source,
      send: (frame) => {
        if (lastPatch([frame]).reset) resets++;
        queue.push(frame);
      },
    });
    const deliver = async () => {
      const frame = queue.shift();
      if (frame !== undefined) client.receive(frame);
      await server.idle();
    };
    client.attach((frame) => server.receive(frame));
    client.open("inbox", newest(5));
    await server.idle();
    await deliver();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    queue.shift();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(103), row: mail(103) }]);
    await server.idle();
    // v3 shows the gap and the client asks; v4 was sent before the server read the ask
    await deliver();
    await deliver();
    expect(client.status()).toBe("resyncing");
    await deliver();
    expect(resets).toBe(2);
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(103, 5));
  });

  test("a socket with no window open is sent nothing when the source changes", async () => {
    const { source, frames, server } = harness(100);
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    expect(frames).toEqual([]);
  });

  test("a close while detached lets go of the window's rows at once", async () => {
    const { client, server } = harness(100);
    client.open("a", newest(3));
    client.open("b", newest(3, { after: 51 }));
    await server.idle();
    server.stop();
    client.detach();
    client.close("b");
    expect(client.held()).toBe(3);
    expect(ats(client.rows("a"))).toEqual(down(100, 3));
  });

  test("a window refused on one socket and served on the next is no longer reported refused", async () => {
    const { client, source, server } = harness(100, { maxWindows: 1 });
    client.open("a", newest(2));
    client.open("b", newest(2, { after: 50 }));
    await server.idle();
    expect(client.refusal("b")).toBe("a socket holds at most 1 windows");
    server.stop();
    client.detach();
    const seen: unknown[] = [];
    client.subscribe(() => seen.push(ats(client.rows("b"))));
    const next = createServerWindows({ source, send: (frame) => client.receive(frame) });
    client.attach((frame) => next.receive(frame));
    await next.idle();
    // the swap waited for the new socket's answer on `b` rather than trusting the old refusal
    expect(seen).toEqual([[49, 48]]);
    expect(client.refusal("b")).toBeUndefined();
    expect(client.status()).toBe("live");
  });

  test("a stopped socket reads no more desires and sends nothing", async () => {
    const { client, server, frames, source } = harness(100);
    client.open("a", newest(2));
    await server.idle();
    server.stop();
    const sent = frames.length;
    const reads = source.pagesRead();
    client.open("b", newest(2, { after: 50 }));
    await server.idle();
    expect(server.held()).toBe(2);
    client.close("a");
    await server.idle();
    expect(server.held()).toBe(2);
    expect(frames.length).toBe(sent);
    expect(source.pagesRead()).toBe(reads);
  });
  test("a row a change moves into an open window shows while a close is in flight", async () => {
    const { client, source, server, queueUp, deliver } = harness(100);
    client.open("top", newest(5));
    client.open("next", newest(5, { after: 96 }));
    await server.idle();
    queueUp();
    client.close("next");
    // the server still counts 95 held through `next`, so it moves into `top` with no put
    source.write(MAIL, [{ key: mailKey(98) }]);
    await server.idle();
    expect(ats(client.rows("top"))).toEqual([100, 99, 97, 96, 95]);
    deliver();
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("top"))).toEqual([100, 99, 97, 96, 95]);
    expect(client.held()).toBe(server.held());
  });

  test("a patch that names a window the client has closed does not bring it back", async () => {
    const { client, source, server, queueUp, deliver } = harness(100);
    client.open("top", newest(2));
    client.open("next", newest(5, { after: 96 }));
    await server.idle();
    queueUp();
    client.close("next");
    source.write(MAIL, [{ key: mailKey(93) }]);
    await server.idle();
    expect(client.rows("next")).toEqual([]);
    deliver();
    await server.idle();
    expect(client.rows("next")).toEqual([]);
    expect(client.held()).toBe(2);
    expect(client.held()).toBe(server.held());
  });

  test("an open that moves a window while patches are in flight lands on the moved rows", async () => {
    const { client, source, server, queueUp, deliver } = harness(100);
    client.open("inbox", newest(3));
    await server.idle();
    queueUp();
    client.open("inbox", newest(3, { after: 50 }));
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    expect(ats(client.rows("inbox"))).toEqual(down(101, 3));
    deliver();
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(49, 3));
    expect(client.held()).toBe(server.held());
  });

  test("a resync whose desire is closed and reopened before the server reads it still gets its reset", async () => {
    const { source } = scripted("ok");
    const sent: Uint8Array[] = [];
    const server = createServerWindows({ source, send: (frame) => sent.push(frame) });
    const text = requestText(CALLS_READ);
    server.receive(desireFrame("w", text));
    await server.idle();
    const at = lastPatch(sent);
    // a read in flight, so the three frames behind it are coalesced before a step reads them
    server.receive(desireFrame("busy", requestText(newest(1))));
    server.receive(desireFrame("w", text, { epoch: "stale", version: 1 }));
    server.receive(undesireFrame("w"));
    server.receive(desireFrame("w", text));
    await server.idle();
    const answer = lastPatch(sent);
    expect(answer.reset).toBe(true);
    expect(answer.epoch).not.toBe(at.epoch);
  });

  test("a resync whose window is closed before the server reads it is still answered with a reset", async () => {
    const { source } = scripted("ok");
    const sent: Uint8Array[] = [];
    const server = createServerWindows({ source, send: (frame) => sent.push(frame) });
    const text = requestText(CALLS_READ);
    server.receive(desireFrame("w", text));
    server.receive(desireFrame("x", text));
    await server.idle();
    server.receive(desireFrame("busy", requestText(newest(1))));
    server.receive(desireFrame("w", text, { epoch: "stale", version: 1 }));
    server.receive(undesireFrame("w"));
    await server.idle();
    expect(lastPatch(sent).reset).toBe(true);
  });

  test("a resync asked while the client's frames queue settles once the server reads them", async () => {
    const { client, source, server, loseNext, queueUp, deliver } = harness(100);
    client.open("inbox", newest(5));
    await server.idle();
    queueUp();
    loseNext();
    source.write(MAIL, [{ key: mailKey(101), row: mail(101) }]);
    await server.idle();
    source.write(MAIL, [{ key: mailKey(102), row: mail(102) }]);
    await server.idle();
    client.open("inbox", newest(4));
    expect(client.status()).toBe("resyncing");
    expect(ats(client.rows("inbox"))).toEqual(down(100, 5));
    deliver();
    await server.idle();
    expect(client.status()).toBe("live");
    expect(ats(client.rows("inbox"))).toEqual(down(102, 4));
    expect(client.held()).toBe(server.held());
  });
});

/** A source whose every read is scripted: each call gets the next answer, the last one repeating. */
const scripted = (...answers: readonly ("ok" | "fail" | "refuse")[]) => {
  let reads = 0;
  let commit: (tables: ReadonlySet<string>) => void = () => undefined;
  let feed: (state: FeedState) => void = () => undefined;
  const source: PageSource = {
    readPage: async (request) => {
      reads++;
      const answer = answers[Math.min(reads, answers.length) - 1];
      if (answer === "fail") return Result.err(new ReadFailed({ message: "statement timeout" }));
      if (answer === "refuse") return Result.err(new ReadRefused({ message: "permission denied" }));
      // the row carries its read and how many reads came before it, so a test sees which it got
      const shown = `${readKey(request)} #${reads}`;
      return Result.ok({
        rows: [{ key: "a", row: new Map([[SUBJECT, shown]]) }],
        tables: new Set([MAIL]),
      });
    },
    onCommit: (listener) => {
      commit = listener;
      return () => undefined;
    },
    onFeed: (listener) => {
      feed = listener;
      return () => undefined;
    },
  };
  return {
    source,
    reads: () => reads,
    commit: () => commit(new Set([MAIL])),
    feed: (state: FeedState) => feed(state),
  };
};

/** One client and one server over `source`, the server's options as given. */
const joined = (source: PageSource, options: Partial<ServerWindowsOptions> = {}) => {
  const client = createWindowClient();
  const server = createServerWindows({
    source,
    send: (frame) => client.receive(frame),
    ...options,
  });
  client.attach((frame) => server.receive(frame));
  return { client, server };
};

const subjectOf = (client: WindowClient, id: string) => client.rows(id)[0]?.row.get(SUBJECT);

/** Long enough that no test sees a retry it did not wait for. */
const NO_RETRY = {
  first: Temporal.Duration.from({ minutes: 1 }),
  most: Temporal.Duration.from({ minutes: 1 }),
} as const satisfies RetryPolicy;

describe("a window whose read fails (D43)", () => {
  test("a failed re-read keeps the rows, marks the window failed, and the next commit reads it again", async () => {
    const { source, commit } = scripted("ok", "fail", "ok");
    const { client, server } = joined(source, { retry: NO_RETRY });
    client.open("w", CALLS_READ);
    await server.idle();
    expect(subjectOf(client, "w")).toEndWith("#1");
    commit();
    await server.idle();
    expect(client.failure("w")).toBe("statement timeout");
    expect(subjectOf(client, "w")).toEndWith("#1");
    commit();
    await server.idle();
    expect(client.failure("w")).toBeUndefined();
    expect(subjectOf(client, "w")).toEndWith("#3");
    server.stop();
  });

  test("a failed window is read again after the retry wait, with no commit to prompt it", async () => {
    const { source, reads } = scripted("fail", "fail", "ok");
    const retry = {
      first: Temporal.Duration.from({ milliseconds: 5 }),
      most: Temporal.Duration.from({ milliseconds: 10 }),
    } as const satisfies RetryPolicy;
    const { client, server } = joined(source, { retry });
    client.open("w", CALLS_READ);
    await server.idle();
    // never answered, and not refused: the window is waiting, failed
    expect(client.arrived("w")).toBe(false);
    expect(client.failure("w")).toBe("statement timeout");
    await eventually(() => client.arrived("w"), "the retried read");
    expect(reads()).toBe(3);
    expect(client.failure("w")).toBeUndefined();
    server.stop();
  });

  test("a refused re-read closes the window, and is not retried", async () => {
    const { source, reads, commit } = scripted("ok", "refuse");
    const { client, server } = joined(source, { retry: NO_RETRY });
    client.open("w", CALLS_READ);
    await server.idle();
    commit();
    await server.idle();
    expect(client.refusal("w")).toBe("permission denied");
    expect(client.failure("w")).toBeUndefined();
    expect(server.held()).toBe(0);
    commit();
    await server.idle();
    expect(reads()).toBe(2);
  });

  test("a lost feed fails every window, and a resumed one reads them all again", async () => {
    const { source, reads, feed } = scripted("ok");
    const { client, server } = joined(source, { retry: NO_RETRY });
    client.open("one", CALLS_READ);
    client.open("two", newest(5));
    await server.idle();
    feed({ kind: "lost", reason: "the change feed stopped" });
    await server.idle();
    expect(client.failure("one")).toBe("the change feed stopped");
    expect(client.failure("two")).toBe("the change feed stopped");
    expect(reads()).toBe(2);
    feed({ kind: "resumed" });
    await server.idle();
    expect(reads()).toBe(4);
    expect(client.failure("one")).toBeUndefined();
    expect(client.failure("two")).toBeUndefined();
    server.stop();
  });
});

describe("what a socket's frames and commits cost (D43)", () => {
  test("two thousand desires for one window are one read, not two thousand", async () => {
    const { source, reads } = scripted("ok");
    const { client, server } = joined(source);
    for (let i = 0; i < 2000; i++) client.open("same", CALLS_READ);
    await server.idle();
    // the first desire is read at once; every one behind it collapses into the latest
    expect(reads()).toBeLessThanOrEqual(2);
    expect(client.arrived("same")).toBe(true);
  });

  test("a burst of commits is one re-read per window, and windows of one read share it", async () => {
    const { source, reads, commit } = scripted("ok");
    const { client, server } = joined(source);
    client.open("one", CALLS_READ);
    client.open("two", CALLS_READ);
    await server.idle();
    const before = reads();
    for (let i = 0; i < 50; i++) commit();
    await server.idle();
    // the first commit starts a re-read, the other 49 wait behind it as one
    expect(reads() - before).toBeLessThanOrEqual(2);
  });

  test("a re-read of many windows asks the source once, and each window gets its own answer", async () => {
    const { source, reads, commit } = scripted("ok");
    const batches: number[] = [];
    const batched: PageSource = {
      ...source,
      readPages: async (requests) => {
        batches.push(requests.length);
        const answers = [];
        for (const request of requests) answers.push(await source.readPage(request));
        return answers;
      },
    };
    const { client, server } = joined(batched);
    for (const q of ["a", "b", "c", "d"]) client.open(q, { path: "search", input: { q } });
    // two windows of one read are one read in the batch
    client.open("d2", { path: "search", input: { q: "d" } });
    await server.idle();
    batches.length = 0;
    const before = reads();
    commit();
    await server.idle();
    expect(batches).toEqual([4]);
    expect(reads() - before).toBe(4);
    for (const q of ["a", "b", "c", "d"])
      expect(subjectOf(client, q)).toStartWith(`["search",{"q":"${q}"}]`);
    expect(subjectOf(client, "d2")).toBe(subjectOf(client, "d"));
  });

  test("a batch the source cannot answer fails every window in it, which keep their rows", async () => {
    const { source, commit } = scripted("ok");
    const { client, server } = joined(
      { ...source, readPages: () => Promise.reject(new Error("connection lost")) },
      { retry: NO_RETRY },
    );
    client.open("a", { path: "search", input: { q: "a" } });
    client.open("b", { path: "search", input: { q: "b" } });
    await server.idle();
    commit();
    await server.idle();
    expect(client.failure("a")).toBe("connection lost");
    expect(client.failure("b")).toBe("connection lost");
    expect(subjectOf(client, "a")).toStartWith('["search",{"q":"a"}]');
  });

  test("a page past the row ceiling is refused, not sent", async () => {
    const { client, server } = harness(100, { maxRows: 10 });
    client.open("inbox", newest(20));
    await server.idle();
    expect(client.refusal("inbox")).toContain("at most 10");
    expect(server.held()).toBe(0);
  });

  test("two inputs of one read keep their own rows, though both hold key a", async () => {
    const { source } = scripted("ok");
    const { client, server } = joined(source);
    client.open("cat", { path: "search", input: { q: "cat" } });
    client.open("dog", { path: "search", input: { q: "dog" } });
    await server.idle();
    expect(subjectOf(client, "cat")).toStartWith('["search",{"q":"cat"}]');
    expect(subjectOf(client, "dog")).toStartWith('["search",{"q":"dog"}]');
  });

  test("a send that throws closes the socket instead of wedging its queue", async () => {
    const { source, reads } = scripted("ok");
    const closed: string[] = [];
    const server = createServerWindows({
      source,
      send: () => {
        throw new Error("socket closed");
      },
      close: (reason) => closed.push(reason),
    });
    const client = createWindowClient();
    client.attach((frame) => server.receive(frame));
    client.open("a", CALLS_READ);
    await server.idle();
    expect(closed).toEqual(["socket closed"]);
    client.open("b", newest(5));
    await server.idle();
    // a closed socket reads nothing more
    expect(reads()).toBe(1);
  });
});
