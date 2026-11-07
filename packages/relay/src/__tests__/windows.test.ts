import type { ColumnName, JsonValue, Row } from "@syncmesh/kernel";
import type { ReadRequest, WindowRow } from "@syncmesh/window";

import { createWindowClient, desireFrame, requestText } from "@syncmesh/window";
import { createMemoryPageSource } from "@syncmesh/window/testing";
import { describe, expect, test } from "bun:test";

import type { RelaySocket, SendOutcome } from "../sender.js";

import { serveWindows } from "../windows.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const BOX = "box" as ColumnName;
const AT = "at" as ColumnName;
const BODY = "body" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const MAIL = "mail";
const keyOf = (box: number, n: number) => `b${box}-${n}`;

const BOXES = 100;
const PER_BOX = 20;
const BODY_BYTES = 16 * 1024;

/* oxlint-disable anti-slop/no-runtime-typeof -- a test read parses its own input */
const boxOf = (input: JsonValue) =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? // SAFETY: a JSON value that is an object and not an array is a JSON object
      Number((input as { readonly [key: string]: JsonValue }).box)
    : -1;
/* oxlint-enable anti-slop/no-runtime-typeof */

/** `mail.box`: one box's rows, newest first. */
const byBox = (rows: readonly WindowRow[], input: JsonValue) =>
  rows
    .filter((r) => r.row.get(BOX) === boxOf(input))
    .sort((a, b) => Number(b.row.get(AT)) - Number(a.row.get(AT)))
    .slice(0, PER_BOX);

/** 100 boxes of 20 rows of 16 KB: about 32 MB once every box's window is open. */
const loaded = () => {
  const source = createMemoryPageSource({ "mail.box": { table: MAIL, page: byBox } });
  const rows: { key: string; row: Row }[] = [];
  for (let box = 0; box < BOXES; box++) {
    const body = String.fromCharCode(97 + (box % 26)).repeat(BODY_BYTES);
    for (let n = 0; n < PER_BOX; n++)
      rows.push({
        key: keyOf(box, n),
        row: new Map<ColumnName, string | number>([
          [BOX, box],
          [AT, n],
          [BODY, body],
        ]),
      });
  }
  source.load(MAIL, rows);
  return source;
};

const boxRead = (box: number): ReadRequest => ({ path: "mail.box", input: { box } });

/**
 * A socket whose buffer takes `room` frames and then reports "dropped" until the host drains,
 * like a WebSocket behind a slow reader. Delivered frames go to `deliver`.
 */
const slowSocket = (room: number, deliver: (frame: Uint8Array) => void) => {
  const buffered: Uint8Array[] = [];
  let closed: string | undefined;
  const socket: RelaySocket = {
    send: (frame): SendOutcome => {
      if (buffered.length >= room) return "dropped";
      buffered.push(frame);
      return "buffered";
    },
    close: (reason) => {
      closed = reason ?? "closed";
    },
  };
  return {
    socket,
    /** The far end reads everything buffered; the host is told the socket drained. */
    flush: () => {
      for (const frame of buffered.splice(0)) deliver(frame);
    },
    closed: () => closed,
  };
};

describe("serving windows on a socket (E27, D39)", () => {
  test("100 disjoint windows over 16 KB rows, a 32 MB burst, arrive whole through backpressure", async () => {
    const source = loaded();
    const client = createWindowClient();
    const wire = slowSocket(8, (frame) => client.receive(frame));
    const served = serveWindows(wire.socket, { source, maxWindows: BOXES });
    client.attach((frame) => served.receive(frame));
    for (let box = 0; box < BOXES; box++) client.open(`box-${box}`, boxRead(box));
    await served.windows.idle();
    // the burst outran the socket: most of it is queued, none of it dropped
    expect(served.backlog()).toBeGreaterThan(0);
    let rounds = 0;
    while (served.backlog() > 0 && rounds++ < 1000) {
      wire.flush();
      served.drain();
    }
    wire.flush();
    expect(wire.closed()).toBeUndefined();
    expect(served.windows.held()).toBe(BOXES * PER_BOX);
    expect(client.held()).toBe(BOXES * PER_BOX);
    for (let box = 0; box < BOXES; box++) {
      const rows = client.rows(`box-${box}`);
      expect(rows.length).toBe(PER_BOX);
      expect(rows.every((r) => r.row.get(BOX) === box)).toBe(true);
    }
  });

  test("a client that cannot keep up is closed, never trimmed, and a new socket resnapshots it", async () => {
    const source = loaded();
    const client = createWindowClient();
    const stalled = slowSocket(0, (frame) => client.receive(frame));
    const first = serveWindows(stalled.socket, { source, maxBacklogBytes: 4 * BODY_BYTES });
    client.attach((frame) => first.receive(frame));
    client.open("box-0", boxRead(0));
    await first.windows.idle();
    expect(stalled.closed()).toContain("backlog ceiling");
    first.close();
    client.detach();
    expect(client.rows("box-0")).toEqual([]);

    const fresh = slowSocket(Number.MAX_SAFE_INTEGER, (frame) => client.receive(frame));
    const second = serveWindows(fresh.socket, { source });
    client.attach((frame) => second.receive(frame));
    await second.windows.idle();
    fresh.flush();
    expect(client.rows("box-0").length).toBe(PER_BOX);
    expect(client.status()).toBe("live");
  });

  test("frames that are not window frames are left for the socket's other reader", () => {
    const served = serveWindows(slowSocket(1, () => {}).socket, { source: loaded() });
    // `ka`, the relay's keepalive, is tag 11
    expect(served.receive(Uint8Array.of(0x81, 0x0b))).toBe(false);
  });

  test("a window frame on a socket already closed is consumed, not passed on", async () => {
    const source = loaded();
    const stalled = slowSocket(0, () => {});
    const served = serveWindows(stalled.socket, { source, maxBacklogBytes: 4 * BODY_BYTES });
    served.receive(desireFrame("box-0", requestText(boxRead(0))));
    await served.windows.idle();
    expect(stalled.closed()).toContain("backlog ceiling");
    expect(served.receive(desireFrame("box-1", requestText(boxRead(1))))).toBe(true);
    expect(served.receive(Uint8Array.of(0x81, 0x0b))).toBe(false);
  });
});
